import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Set
from fastapi import WebSocket
from sqlalchemy.orm import Session

from config import (
    PAPER_THRESHOLD_OK,
    PAPER_THRESHOLD_LOW,
    OFFLINE_TIMEOUT_SECONDS,
    OFFLINE_CHECK_INTERVAL_SECONDS
)
from database import SessionLocal
from models import Device, Toilet, StatusHistory, Alert

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return
        dead_connections = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.append(connection)
        for dead in dead_connections:
            self.disconnect(dead)

manager = ConnectionManager()

def evaluate_device_status(paper_level: float, last_seen: Optional[datetime]) -> str:
    now = datetime.now(timezone.utc)
    if last_seen is None:
        return "OFFLINE"
    
    # Handle timezone naive/aware comparison safely
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
        
    if (now - last_seen).total_seconds() > OFFLINE_TIMEOUT_SECONDS:
        return "OFFLINE"
    
    if paper_level <= PAPER_THRESHOLD_LOW:
        return "EMPTY"
    elif paper_level <= PAPER_THRESHOLD_OK:
        return "LOW"
    else:
        return "OK"

def evaluate_toilet_status(devices: List[Device], gateway=None) -> str:
    """
    Đánh giá trạng thái tổng thể của Nhà vệ sinh:
    1. Nếu Gateway bị mất kết nối (> 10 phút) -> Toàn bộ Toilet chuyển thành OFFLINE.
    2. Nếu không có thiết bị -> Trả về OFFLINE nếu Gateway mất kết nối, ngược lại OK.
    3. Đánh giá theo mức độ nghiêm trọng: EMPTY > LOW > OFFLINE > OK.
    """
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS
    now = datetime.now(timezone.utc)

    # 1. Chưa gán Gateway -> Màu xám (OFFLINE)
    if not gateway:
        return "OFFLINE"

    # 2. Kiểm tra trạng thái Gateway
    ls = gateway.last_seen
    if ls and ls.tzinfo is None:
        ls = ls.replace(tzinfo=timezone.utc)
    if ls is None or (now - ls).total_seconds() > GATEWAY_OFFLINE_TIMEOUT_SECONDS:
        return "OFFLINE"

    # 3. Chưa có thiết bị cảm biến đang sử dụng -> Màu xám (OFFLINE)
    if not devices:
        return "OFFLINE"
    
    statuses = [d.status for d in devices]
    if "EMPTY" in statuses:
        return "EMPTY"
    if "LOW" in statuses:
        return "LOW"
    if "OFFLINE" in statuses:
        return "OFFLINE"
    return "OK"

def trigger_alert_if_needed(db: Session, device: Device, new_status: str) -> Optional[Alert]:
    alert_type_map = {
        "LOW": "LOW_PAPER",
        "EMPTY": "EMPTY",
        "OFFLINE": "OFFLINE"
    }
    
    alert_type = alert_type_map.get(new_status)
    if not alert_type:
        return None
    
    # Check if there is already an active unacknowledged alert of the same type for this device
    existing_unack = db.query(Alert).filter(
        Alert.device_id == device.id,
        Alert.type == alert_type,
        Alert.acknowledged_at == None
    ).first()
    
    if existing_unack:
        return None  # Avoid duplicate alerts while unacknowledged

    alert = Alert(
        device_id=device.id,
        type=alert_type,
        created_at=datetime.now(timezone.utc)
    )
    db.add(alert)
    db.flush()
    return alert

async def offline_checker_task():
    """
    Background task running every 15s:
    1. Kiểm tra Client: Nếu không có tín hiệu trong 1 tiếng (3600s) -> Chuyển sang OFFLINE và kích hoạt Alert.
    2. Kiểm tra Gateway: Nếu sau 10 phút (600s) không gửi báo cáo -> Phát sự kiện GATEWAY_STATUS update.
    """
    from config import CLIENT_OFFLINE_TIMEOUT_SECONDS, GATEWAY_OFFLINE_TIMEOUT_SECONDS
    from models import Gateway

    while True:
        try:
            await asyncio.sleep(OFFLINE_CHECK_INTERVAL_SECONDS)
            db: Session = SessionLocal()
            try:
                now = datetime.now(timezone.utc)
                client_cutoff = now - timedelta(seconds=CLIENT_OFFLINE_TIMEOUT_SECONDS)
                gw_cutoff = now - timedelta(seconds=GATEWAY_OFFLINE_TIMEOUT_SECONDS)
                
                # 1. Kiểm tra các thiết bị Client (hơn 1 tiếng không liên lạc)
                devices = db.query(Device).filter(Device.status != "OFFLINE").all()
                changed_devices = []
                new_alerts = []

                for dev in devices:
                    last_seen = dev.last_seen
                    if last_seen and last_seen.tzinfo is None:
                        last_seen = last_seen.replace(tzinfo=timezone.utc)

                    if last_seen is None or last_seen < client_cutoff:
                        dev.status = "OFFLINE"
                        changed_devices.append(dev)
                        
                        # Add status history
                        history = StatusHistory(
                            device_id=dev.id,
                            paper_level=dev.paper_level,
                            status="OFFLINE",
                            timestamp=now
                        )
                        db.add(history)
                        
                        alert = trigger_alert_if_needed(db, dev, "OFFLINE")
                        if alert:
                            new_alerts.append((alert, dev))

                if changed_devices:
                    db.commit()

                    # Broadcast alerts
                    for alert, dev in new_alerts:
                        toilet = dev.gateway.toilet if dev.gateway else None
                        await manager.broadcast({
                            "event": "NEW_ALERT",
                            "data": {
                                "id": alert.id,
                                "device_id": dev.id,
                                "device_label": dev.label,
                                "toilet_id": toilet.id if toilet else None,
                                "toilet_name": toilet.name if toilet else "Không rõ",
                                "floor_name": toilet.floor.name if (toilet and toilet.floor) else "Không rõ",
                                "terminal_name": toilet.floor.terminal.name if (toilet and toilet.floor and toilet.floor.terminal) else "Không rõ",
                                "type": alert.type,
                                "created_at": alert.created_at.isoformat()
                            }
                        })

                # 2. Kiểm tra các Gateway bị mất kết nối (> 10 phút)
                gateways = db.query(Gateway).all()
                affected_toilets = set()

                for gw in gateways:
                    ls = gw.last_seen
                    if ls and ls.tzinfo is None:
                        ls = ls.replace(tzinfo=timezone.utc)
                    if ls is None or ls < gw_cutoff:
                        if gw.toilet:
                            affected_toilets.add(gw.toilet)

                for dev in changed_devices:
                    if dev.gateway and dev.gateway.toilet:
                        affected_toilets.add(dev.gateway.toilet)

                for toilet in affected_toilets:
                    t_status = evaluate_toilet_status(toilet.gateway.devices if toilet.gateway else [], gateway=toilet.gateway)
                    gw = toilet.gateway
                    gw_is_online = False
                    if gw and gw.last_seen:
                        ls_gw = gw.last_seen.replace(tzinfo=timezone.utc) if gw.last_seen.tzinfo is None else gw.last_seen
                        gw_is_online = (now - ls_gw).total_seconds() <= GATEWAY_OFFLINE_TIMEOUT_SECONDS

                    await manager.broadcast({
                        "event": "STATE_UPDATE",
                        "data": {
                            "toilet_id": toilet.id,
                            "toilet_name": toilet.name,
                            "floor_id": toilet.floor_id,
                            "status": t_status,
                            "gateway_id": gw.id if gw else None,
                            "gateway_ip": gw.ip_address if gw else None,
                            "gateway_online": gw_is_online,
                            "devices": [
                                    {
                                        "id": d.id,
                                        "mac_address": d.mac_address,
                                        "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                                        "label": d.label,
                                        "paper_level": d.paper_level,
                                        "battery": d.battery,
                                        "status": "OFFLINE" if not gw_is_online else d.status,
                                        "last_seen": d.last_seen.isoformat() if d.last_seen else None
                                    }
                                    for d in sorted(toilet.gateway.devices if toilet.gateway else [], key=lambda x: (x.cabin_order if x.cabin_order is not None else 999, x.id))
                                ]
                            }
                        })
            except Exception as e:
                db.rollback()
                print(f"[Offline Checker] Error: {e}")
            finally:
                db.close()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Offline Checker Task Loop] Error: {e}")
