from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Header, HTTPException, Request, Depends, status
from sqlalchemy.orm import Session

from config import GATEWAY_API_KEY
from database import get_db
from models import Gateway, Device, StatusHistory, Toilet
from schemas import GatewayReportRequest
from services.state_service import (
    evaluate_device_status,
    evaluate_toilet_status,
    trigger_alert_if_needed,
    manager
)

router = APIRouter(prefix="/api/gateway", tags=["gateway"])

@router.post("/report")
async def receive_gateway_report(
    payload: GatewayReportRequest,
    request: Request,
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    db: Session = Depends(get_db)
):
    # Verify API Key
    if not x_api_key or x_api_key != GATEWAY_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API Key không hợp lệ hoặc bị thiếu trong header X-API-Key"
        )

    # Determine gateway IP
    effective_ip = payload.gateway_ip.strip() if payload.gateway_ip else (request.client.host if request.client else "127.0.0.1")
    print(f"[Gateway API] Received report from IP: {effective_ip} with {len(payload.devices)} devices")

    # Find registered gateway, or auto-register if new (WITHOUT auto-creating toilet on map)
    gateway = db.query(Gateway).filter(Gateway.ip_address == effective_ip).first()
    if not gateway:
        print(f"[Gateway API] Gateway IP {effective_ip} is new. Registering Gateway as unassigned...")
        # [CODE CU]: Tu dong tao Toilet va ghim len ban do tang
        # assigned_toilet = db.query(Toilet).filter(Toilet.gateway_id == None).first()
        # ...
        # [CODE MOI]: Chi tao Gateway trong CSDL voi toilet_id = None. Nguoi dung se tu them Toilet len map sau!
        gateway = Gateway(
            ip_address=effective_ip,
            toilet_id=None,
            last_seen=datetime.now(timezone.utc)
        )
        db.add(gateway)
        db.flush()
        print(f"[Gateway API] Successfully registered new Gateway #{gateway.id} (IP: {effective_ip}) - Unassigned Toilet")

    now = datetime.now(timezone.utc)
    gateway.last_seen = now

    new_alerts = []
    
    from services.paper_service import calculate_paper_metrics

    # Process each device in report
    for dev_in in payload.devices:
        clean_mac = dev_in.mac.strip().upper()
        device = db.query(Device).filter(Device.mac_address == clean_mac).first()

        # SERVER PHÂN TÍCH VÀ QUY ĐỔI KHOẢNG CÁCH (mm) -> PHẦN TRĂM GIẤY (%) & ĐỘ DÀY (cm) & LƯỢT DÙNG
        raw_dist = dev_in.distance if dev_in.distance is not None else dev_in.distance_mm
        sensor_st = dev_in.sensor_status if dev_in.sensor_status is not None else 0

        metrics = calculate_paper_metrics(raw_dist, sensor_st)
        calc_paper = metrics["paper_level"]
        new_status = metrics["status"]
        print(f"[Device Report] {clean_mac} -> dist={raw_dist}mm, st={sensor_st}, paper={calc_paper}%, thick={metrics['remaining_thickness_cm']}cm, uses={metrics['estimated_uses']}, bat={dev_in.battery}%, status={new_status}")

        if not device:
            # Client is active but NOT saved into database (per user requirement)
            from services.discovery_service import discovery_service
            discovery_service.register_live_client(
                gateway_ip=effective_ip,
                mac=clean_mac,
                paper_level=calc_paper,
                battery=dev_in.battery,
                status=new_status,
                distance=raw_dist,
                remaining_thickness_cm=metrics["remaining_thickness_cm"],
                remaining_thickness_mm=metrics["remaining_thickness_mm"],
                estimated_uses=metrics["estimated_uses"]
            )
            continue
        
        # If device is saved in DB, update it
        from services.discovery_service import discovery_service
        discovery_service.remove_saved_client(clean_mac)

        old_status = device.status
        old_paper = device.paper_level
        # Ensure device points to current gateway if re-associated
        if device.gateway_id != gateway.id:
            device.gateway_id = gateway.id

        has_changed = (old_status is None) or (new_status != old_status) or (abs(device.paper_level - calc_paper) >= 1.0)
        
        device.paper_level = calc_paper
        device.battery = round(float(dev_in.battery), 1)
        device.status = new_status
        device.last_seen = now

        if has_changed:
            history = StatusHistory(
                device_id=device.id,
                paper_level=device.paper_level,
                status=device.status,
                timestamp=now
            )
            db.add(history)

        # Trigger alert if moved to alert state
        alert = trigger_alert_if_needed(db, device, new_status)
        if alert:
            new_alerts.append((alert, device))

    db.commit()

    # Broadcast alerts if any
    for alert, dev in new_alerts:
        toilet = gateway.toilet
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

    from services.discovery_service import discovery_service
    discovered_list = discovery_service.get_discovered_for_gateway(effective_ip)
    saved_macs = {d.mac_address for d in gateway.devices}
    unsaved_discovered = [d for d in discovered_list if d["mac_address"] not in saved_macs]

    # Broadcast updated toilet state (including live unsaved discovered devices)
    if gateway.toilet:
        toilet = gateway.toilet
        t_status = evaluate_toilet_status(gateway.devices)
        from services.paper_service import calculate_metrics_from_percent
        dev_list = []
        for d in sorted(gateway.devices, key=lambda x: (x.cabin_order if x.cabin_order is not None else 999, x.id)):
            m = calculate_metrics_from_percent(d.paper_level)
            dev_list.append({
                "id": d.id,
                "mac_address": d.mac_address,
                "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                "label": d.label,
                "paper_level": d.paper_level,
                "remaining_thickness_cm": m["remaining_thickness_cm"],
                "remaining_thickness_mm": m["remaining_thickness_mm"],
                "estimated_uses": m["estimated_uses"],
                "battery": d.battery,
                "status": d.status,
                "last_seen": d.last_seen.isoformat() if d.last_seen else None
            })

        await manager.broadcast({
            "event": "STATE_UPDATE",
            "data": {
                "toilet_id": toilet.id,
                "toilet_name": toilet.name,
                "floor_id": toilet.floor_id,
                "status": t_status,
                "gateway_id": gateway.id,
                "gateway_ip": effective_ip,
                "gateway_online": True,
                "devices": dev_list,
                "discovered_devices": unsaved_discovered
            }
        })

    # Also broadcast DISCOVERED_CLIENTS_UPDATE for any listener monitoring this gateway IP
    await manager.broadcast({
        "event": "DISCOVERED_CLIENTS_UPDATE",
        "data": {
            "gateway_ip": effective_ip,
            "toilet_id": gateway.toilet.id if gateway.toilet else None,
            "discovered_devices": unsaved_discovered
        }
    })

    return {
        "status": "success",
        "gateway_ip": effective_ip,
        "processed_devices": len(payload.devices)
    }
