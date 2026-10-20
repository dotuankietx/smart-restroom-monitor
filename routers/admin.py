import os
import shutil
import time
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy.orm import Session

from config import UPLOAD_DIR, MAX_FILE_SIZE_BYTES, ALLOWED_EXTENSIONS
from database import get_db
from models import User, Floor, Toilet, Gateway, Device, StatusHistory, Alert
from schemas import (
    UserCreate, UserUpdate, UserOut, ToiletCreate, ToiletUpdate, DeviceCreate, DeviceUpdate
)
from services.auth_service import require_admin, get_password_hash

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

# ================= USER MANAGEMENT =================
@router.get("/users", response_model=List[UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.query(User).all()

@router.post("/users", response_model=UserOut)
def create_user(payload: UserCreate, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.username == payload.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Tên người dùng đã tồn tại")

    user = User(
        username=payload.username,
        password_hash=get_password_hash(payload.password),
        role=payload.role,
        must_change_password=False
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@router.put("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

    if payload.role:
        user.role = payload.role
    if payload.new_password:
        user.password_hash = get_password_hash(payload.new_password)
        user.must_change_password = False

    db.commit()
    db.refresh(user)
    return user

@router.delete("/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Không thể tự xoá tài khoản đang đăng nhập")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

    db.delete(user)
    db.commit()
    return {"message": "Đã xoá người dùng thành công"}

# ================= MAP PDF UPLOAD =================
@router.post("/floors/{floor_id}/map")
async def upload_floor_map(
    floor_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Không tìm thấy tầng")

    # Validate file extension
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Chỉ chấp nhận file định dạng .pdf")

    # Save to uploads dir
    filename = f"map_floor_{floor_id}_{int(time.time())}.pdf"
    file_path = UPLOAD_DIR / filename

    size = 0
    with open(file_path, "wb") as buffer:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE_SIZE_BYTES:
                buffer.close()
                if file_path.exists():
                    os.remove(file_path)
                raise HTTPException(status_code=400, detail="Dung lượng file vượt quá giới hạn 20MB")
            buffer.write(chunk)

    # Relative path for serving
    floor.map_pdf_path = f"/uploads/{filename}"
    db.commit()

    return {
        "status": "success",
        "message": f"Đã tải lên bản đồ cho {floor.name}",
        "map_pdf_path": floor.map_pdf_path
    }

# ================= TOILET CRUD & PLACEMENT =================
@router.post("/toilets")
def create_toilet(payload: ToiletCreate, db: Session = Depends(get_db)):
    floor = db.query(Floor).filter(Floor.id == payload.floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Không tìm thấy tầng tương ứng")

    gateway = None
    if payload.gateway_ip and payload.gateway_ip.strip():
        ip = payload.gateway_ip.strip()
        gateway = db.query(Gateway).filter(Gateway.ip_address == ip).first()
        if not gateway:
            gateway = Gateway(ip_address=ip)
            db.add(gateway)
            db.flush()
        else:
            # If gateway was linked to another toilet, unlink it
            if gateway.toilet_id:
                old_t = db.query(Toilet).filter(Toilet.id == gateway.toilet_id).first()
                if old_t:
                    old_t.gateway_id = None
                    if old_t.name.startswith("Toilet GW-"):
                        db.delete(old_t)
                gateway.toilet_id = None
                db.flush()

    toilet = Toilet(
        floor_id=payload.floor_id,
        name=payload.name.strip(),
        x=payload.x,
        y=payload.y,
        gateway_id=gateway.id if gateway else None
    )
    db.add(toilet)
    db.commit()
    db.refresh(toilet)

    if gateway:
        gateway.toilet_id = toilet.id
        db.commit()

    return {
        "id": toilet.id,
        "name": toilet.name,
        "floor_id": toilet.floor_id,
        "x": toilet.x,
        "y": toilet.y,
        "gateway_ip": gateway.ip_address if gateway else None
    }

@router.put("/toilets/{toilet_id}")
def update_toilet(toilet_id: int, payload: ToiletUpdate, db: Session = Depends(get_db)):
    toilet = db.query(Toilet).filter(Toilet.id == toilet_id).first()
    if not toilet:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")

    if payload.name is not None:
        toilet.name = payload.name.strip()
    if payload.x is not None:
        toilet.x = payload.x
    if payload.y is not None:
        toilet.y = payload.y

    if payload.gateway_ip is not None:
        ip = payload.gateway_ip.strip()
        if ip:
            gateway = db.query(Gateway).filter(Gateway.ip_address == ip).first()
            if not gateway:
                gateway = Gateway(ip_address=ip)
                db.add(gateway)
                db.flush()

            # 1. Unlink any other gateways currently pointing to this toilet
            other_gws = db.query(Gateway).filter(Gateway.toilet_id == toilet.id, Gateway.id != gateway.id).all()
            for og in other_gws:
                og.toilet_id = None
            db.flush()

            # 2. If this gateway was assigned to a different toilet, unlink that old toilet
            if gateway.toilet_id and gateway.toilet_id != toilet.id:
                old_t = db.query(Toilet).filter(Toilet.id == gateway.toilet_id).first()
                if old_t:
                    old_t.gateway_id = None
                    if old_t.name.startswith("Toilet GW-"):
                        db.delete(old_t)
                gateway.toilet_id = None
                db.flush()

            # 3. If other toilets point to this gateway, clear their gateway_id
            other_toilets = db.query(Toilet).filter(Toilet.gateway_id == gateway.id, Toilet.id != toilet.id).all()
            for ot in other_toilets:
                ot.gateway_id = None
            db.flush()

            # 4. Safely link toilet and gateway together
            toilet.gateway_id = gateway.id
            gateway.toilet_id = toilet.id
            db.flush()
        else:
            if toilet.gateway:
                toilet.gateway.toilet_id = None
            other_gws = db.query(Gateway).filter(Gateway.toilet_id == toilet.id).all()
            for og in other_gws:
                og.toilet_id = None
            toilet.gateway_id = None
            db.flush()

    db.commit()
    db.refresh(toilet)
    return {
        "id": toilet.id,
        "name": toilet.name,
        "floor_id": toilet.floor_id,
        "x": toilet.x,
        "y": toilet.y,
        "gateway_ip": toilet.gateway.ip_address if toilet.gateway else None
    }

@router.delete("/toilets/{toilet_id}")
def delete_toilet(toilet_id: int, db: Session = Depends(get_db)):
    toilet = db.query(Toilet).filter(Toilet.id == toilet_id).first()
    if not toilet:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")

    if toilet.gateway:
        toilet.gateway.toilet_id = None

    db.delete(toilet)
    db.commit()
    return {"message": "Đã xoá nhà vệ sinh thành công"}

# ================= GATEWAY & DEVICE MANAGEMENT =================
@router.get("/gateways")
def list_gateways(db: Session = Depends(get_db)):
    gateways = db.query(Gateway).all()
    now = datetime.now(timezone.utc)
    results = []
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS
    for gw in gateways:
        ls = gw.last_seen
        if ls and ls.tzinfo is None:
            ls = ls.replace(tzinfo=timezone.utc)
        
        diff_sec = (now - ls).total_seconds() if ls else 999999
        is_online = (diff_sec <= GATEWAY_OFFLINE_TIMEOUT_SECONDS)
        # Gateway được coi là "MỚI" nếu chưa được gán vào Toilet nào (toilet_id is None)
        is_new = (gw.toilet_id is None)

        toilet = gw.toilet
        floor = toilet.floor if toilet else None
        terminal = floor.terminal if floor else None

        results.append({
            "id": gw.id,
            "ip_address": gw.ip_address,
            "toilet_id": toilet.id if toilet else None,
            "toilet_name": toilet.name if toilet else "Chưa gán",
            "terminal_name": terminal.name if terminal else "—",
            "floor_name": floor.name if floor else "—",
            "last_seen": gw.last_seen.isoformat() if gw.last_seen else None,
            "device_count": len(gw.devices),
            "is_new": is_new,
            "is_online": is_online,
            "status": "ONLINE" if is_online else "OFFLINE"
        })
    return results

@router.get("/gateways/ping")
async def ping_gateway(ip: str, db: Session = Depends(get_db)):
    """
    Kiểm tra trạng thái kết nối của Gateway dựa trên:
    1. Thời gian nhận gói tin lần cuối (last_seen) trong CSDL (offline nếu > 10 phút)
    2. Độ trễ hoặc thời gian trôi qua kể từ lần liên lạc gần nhất
    """
    clean_ip = ip.strip()
    gw = db.query(Gateway).filter(Gateway.ip_address == clean_ip).first()
    if not gw:
        raise HTTPException(status_code=404, detail=f"Không tìm thấy Gateway với IP {clean_ip}")

    now = datetime.now(timezone.utc)
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS

    ls = gw.last_seen
    if ls and ls.tzinfo is None:
        ls = ls.replace(tzinfo=timezone.utc)

    if not ls:
        return {
            "gateway_ip": clean_ip,
            "online": False,
            "elapsed_seconds": None,
            "message": "Gateway chưa từng gửi bất kỳ gói tin nào về Server."
        }

    elapsed = (now - ls).total_seconds()
    is_online = (elapsed <= GATEWAY_OFFLINE_TIMEOUT_SECONDS)

    # 1. Thử gửi gói ping ICMP thực tế đến IP của Gateway (thời gian chờ 1.2 giây)
    import subprocess, platform
    is_reachable = False
    try:
        param = "-n 1 -w 1200" if platform.system().lower() == "windows" else "-c 1 -W 1"
        res = subprocess.run(f"ping {param} {clean_ip}", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True)
        is_reachable = (res.returncode == 0)
    except Exception:
        is_reachable = False

    last_seen_str = ls.strftime("%H:%M:%S %d/%m/%Y")
    minutes_ago = int(elapsed // 60)
    seconds_ago = int(elapsed % 60)

    # Nếu vừa ping ICMP được HOẶC vừa mới gửi gói tin trong vòng 10 phút
    # Nhưng nếu ping thực tế thất bại VÀ người dùng chủ động bấm kiểm tra:
    # Nếu IP cục bộ không ping được (mất nguồn) -> Báo ngay là Mất kết nối!
    final_online = is_reachable or (is_online and not clean_ip.startswith("192.168."))

    if not is_reachable and (clean_ip.startswith("192.168.") or clean_ip.startswith("10.") or clean_ip.startswith("172.")):
        final_online = False
        msg = f"Đã mất kết nối vật lý (Thiết bị không phản hồi, đã tắt nguồn hoặc rớt Wi-Fi. Lần liên lạc cuối: {last_seen_str})"
        # Cập nhật thời gian last_seen lùi về quá 10 phút trước để CSDL và toàn bộ hệ thống (Map, WS) đều coi Gateway là OFFLINE
        gw.last_seen = now - timedelta(seconds=GATEWAY_OFFLINE_TIMEOUT_SECONDS + 10)
        for d in gw.devices:
            d.status = "OFFLINE"
        db.commit()

        # Phát sóng WebSocket cập nhật ngay lập tức trạng thái Toilet
        if gw.toilet:
            from services.state_service import evaluate_toilet_status, manager
            t_status = evaluate_toilet_status(gw.devices, gateway=gw)
            await manager.broadcast({
                "event": "STATE_UPDATE",
                "data": {
                    "toilet_id": gw.toilet.id,
                    "toilet_name": gw.toilet.name,
                    "floor_id": gw.toilet.floor_id,
                    "status": t_status,
                    "gateway_id": gw.id,
                    "gateway_ip": gw.ip_address,
                    "gateway_online": False,
                    "devices": [
                        {
                            "id": d.id,
                            "mac_address": d.mac_address,
                            "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                            "label": d.label,
                            "paper_level": d.paper_level,
                            "battery": d.battery,
                            "status": "OFFLINE",
                            "last_seen": d.last_seen.isoformat() if d.last_seen else None
                        } for d in gw.devices
                    ]
                }
            })
    elif is_reachable:
        final_online = True
        msg = f"Đang phản hồi tín hiệu tốt! (Ping mạng OK, dữ liệu gần nhất: {minutes_ago}p {seconds_ago}s trước)"
        gw.last_seen = now
        from services.state_service import evaluate_device_status, evaluate_toilet_status, manager
        for d in gw.devices:
            d.status = evaluate_device_status(d.paper_level, d.last_seen)
        db.commit()
        last_seen_str = now.strftime("%H:%M:%S %d/%m/%Y")
        ls = now
        elapsed = 0

        if gw.toilet:
            t_status = evaluate_toilet_status(gw.devices, gateway=gw)
            await manager.broadcast({
                "event": "STATE_UPDATE",
                "data": {
                    "toilet_id": gw.toilet.id,
                    "toilet_name": gw.toilet.name,
                    "floor_id": gw.toilet.floor_id,
                    "status": t_status,
                    "gateway_id": gw.id,
                    "gateway_ip": gw.ip_address,
                    "gateway_online": True,
                    "devices": [
                        {
                            "id": d.id,
                            "mac_address": d.mac_address,
                            "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                            "label": d.label,
                            "paper_level": d.paper_level,
                            "battery": d.battery,
                            "status": d.status,
                            "last_seen": d.last_seen.isoformat() if d.last_seen else None
                        } for d in gw.devices
                    ]
                }
            })
    elif is_online:
        final_online = True
        msg = f"Đang hoạt động tốt (Gói tin gần nhất: {minutes_ago}p {seconds_ago}s trước)"
        from services.state_service import evaluate_device_status, evaluate_toilet_status, manager
        for d in gw.devices:
            d.status = evaluate_device_status(d.paper_level, d.last_seen)
        db.commit()
        if gw.toilet:
            t_status = evaluate_toilet_status(gw.devices, gateway=gw)
            await manager.broadcast({
                "event": "STATE_UPDATE",
                "data": {
                    "toilet_id": gw.toilet.id,
                    "toilet_name": gw.toilet.name,
                    "floor_id": gw.toilet.floor_id,
                    "status": t_status,
                    "gateway_id": gw.id,
                    "gateway_ip": gw.ip_address,
                    "gateway_online": True,
                    "devices": [
                        {
                            "id": d.id,
                            "mac_address": d.mac_address,
                            "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                            "label": d.label,
                            "paper_level": d.paper_level,
                            "battery": d.battery,
                            "status": d.status,
                            "last_seen": d.last_seen.isoformat() if d.last_seen else None
                        } for d in gw.devices
                    ]
                }
            })
    else:
        final_online = False
        msg = f"Đã mất kết nối trong {minutes_ago} phút qua (Lần cuối: {last_seen_str})"

    return {
        "gateway_ip": clean_ip,
        "online": final_online,
        "ping_ok": is_reachable,
        "elapsed_seconds": round(elapsed, 1),
        "last_seen": ls.isoformat(),
        "last_seen_str": last_seen_str,
        "message": msg
    }

@router.get("/gateways/ping-all")
async def ping_all_gateways(db: Session = Depends(get_db)):
    """
    Kiểm tra trạng thái kết nối của TẤT CẢ các Gateway trong hệ thống cùng lúc.
    """
    gateways = db.query(Gateway).all()
    results = []
    online_count = 0
    offline_count = 0
    now = datetime.now(timezone.utc)
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS
    import subprocess, platform

    for gw in gateways:
        clean_ip = gw.ip_address.strip() if gw.ip_address else ""
        ls = gw.last_seen
        if ls and ls.tzinfo is None:
            ls = ls.replace(tzinfo=timezone.utc)

        elapsed = (now - ls).total_seconds() if ls else 999999
        is_online = (elapsed <= GATEWAY_OFFLINE_TIMEOUT_SECONDS)

        is_reachable = False
        if clean_ip:
            try:
                param = "-n 1 -w 1000" if platform.system().lower() == "windows" else "-c 1 -W 1"
                res = subprocess.run(f"ping {param} {clean_ip}", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True)
                is_reachable = (res.returncode == 0)
            except Exception:
                is_reachable = False

        if not is_reachable and (clean_ip.startswith("192.168.") or clean_ip.startswith("10.") or clean_ip.startswith("172.")):
            final_online = False
            gw.last_seen = now - timedelta(seconds=GATEWAY_OFFLINE_TIMEOUT_SECONDS + 10)
            for d in gw.devices:
                d.status = "OFFLINE"
            offline_count += 1
        elif is_reachable or is_online:
            final_online = True
            online_count += 1
            if is_reachable:
                gw.last_seen = now
            from services.state_service import evaluate_device_status
            for d in gw.devices:
                d.status = evaluate_device_status(d.paper_level, d.last_seen)
        else:
            final_online = False
            offline_count += 1

        results.append({
            "id": gw.id,
            "ip_address": clean_ip,
            "online": final_online,
            "ping_ok": is_reachable,
            "last_seen": gw.last_seen.isoformat() if gw.last_seen else None
        })

    db.commit()

    # Phát sóng cập nhật trạng thái nếu có thay đổi
    from services.state_service import evaluate_toilet_status, manager
    for gw in gateways:
        if gw.toilet:
            t_status = evaluate_toilet_status(gw.devices, gateway=gw)
            gw_online_status = False
            if gw.last_seen:
                ls_t = gw.last_seen.replace(tzinfo=timezone.utc) if gw.last_seen.tzinfo is None else gw.last_seen
                gw_online_status = (now - ls_t).total_seconds() <= GATEWAY_OFFLINE_TIMEOUT_SECONDS
            await manager.broadcast({
                "event": "STATE_UPDATE",
                "data": {
                    "toilet_id": gw.toilet.id,
                    "toilet_name": gw.toilet.name,
                    "floor_id": gw.toilet.floor_id,
                    "status": t_status,
                    "gateway_id": gw.id,
                    "gateway_ip": gw.ip_address,
                    "gateway_online": gw_online_status,
                    "devices": [
                        {
                            "id": d.id,
                            "mac_address": d.mac_address,
                            "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
                            "label": d.label,
                            "paper_level": d.paper_level,
                            "battery": d.battery,
                            "status": "OFFLINE" if not gw_online_status else d.status,
                            "last_seen": d.last_seen.isoformat() if d.last_seen else None
                        } for d in gw.devices
                    ]
                }
            })

    return {
        "total": len(gateways),
        "online_count": online_count,
        "offline_count": offline_count,
        "results": results
    }

@router.post("/gateways")
def create_gateway(ip_address: str, db: Session = Depends(get_db)):
    ip = ip_address.strip()
    existing = db.query(Gateway).filter(Gateway.ip_address == ip).first()
    if existing:
        raise HTTPException(status_code=400, detail="IP Gateway này đã tồn tại")
    
    gw = Gateway(ip_address=ip)
    db.add(gw)
    db.commit()
    db.refresh(gw)
    return {"id": gw.id, "ip_address": gw.ip_address}

@router.delete("/gateways/{gateway_id}")
def delete_gateway(gateway_id: int, db: Session = Depends(get_db)):
    gw = db.query(Gateway).filter(Gateway.id == gateway_id).first()
    if not gw:
        raise HTTPException(status_code=404, detail="Không tìm thấy Gateway")
    
    # Detach from toilet
    toilets = db.query(Toilet).filter(Toilet.gateway_id == gateway_id).all()
    for t in toilets:
        t.gateway_id = None

    db.delete(gw)
    db.commit()
    return {"message": "Đã xoá Gateway thành công"}

@router.get("/devices")
def list_devices(db: Session = Depends(get_db)):
    devices = db.query(Device).order_by(Device.gateway_id, Device.cabin_order).all()
    results = []
    for d in devices:
        gw = d.gateway
        toilet = gw.toilet if gw else None
        results.append({
            "id": d.id,
            "mac_address": d.mac_address,
            "cabin_order": d.cabin_order,
            "label": d.label,
            "gateway_id": d.gateway_id,
            "gateway_ip": gw.ip_address if gw else "Không rõ",
            "toilet_name": toilet.name if toilet else "Chưa gán",
            "paper_level": d.paper_level,
            "battery": d.battery,
            "status": d.status,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None
        })
    return results

@router.post("/devices")
def create_device(payload: DeviceCreate, db: Session = Depends(get_db)):
    clean_mac = payload.mac_address.strip().upper()
    existing = db.query(Device).filter(Device.mac_address == clean_mac).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Thiết bị với địa chỉ MAC '{clean_mac}' đã tồn tại trong hệ thống"
        )

    gateway_id = payload.gateway_id
    if not gateway_id and payload.toilet_id:
        toilet = db.query(Toilet).filter(Toilet.id == payload.toilet_id).first()
        if not toilet:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")
        if toilet.gateway:
            gateway_id = toilet.gateway.id
        else:
            # Tự động tạo 1 Gateway cho toilet này nếu chưa có
            gw_ip = f"192.168.{toilet.floor_id + 10}.{toilet.id + 10}"
            gateway = Gateway(ip_address=gw_ip, toilet_id=toilet.id)
            db.add(gateway)
            db.flush()
            toilet.gateway_id = gateway.id
            gateway_id = gateway.id

    if not gateway_id:
        raise HTTPException(status_code=400, detail="Vui lòng chỉ định Gateway hoặc Nhà vệ sinh cho thiết bị")

    from services.discovery_service import discovery_service
    initial_paper = 100.0
    initial_battery = 100.0
    initial_status = "OK"

    # Check if there is live discovered data for this MAC
    for gw_devs in discovery_service.get_all_discovered().values():
        for d in gw_devs:
            if d.get("mac_address") == clean_mac:
                initial_paper = d.get("paper_level", 100.0)
                initial_battery = d.get("battery", 100.0)
                initial_status = d.get("status", "OK")
                break

    label = payload.label.strip() if payload.label else f"Cabin {payload.cabin_order}"
    dev = Device(
        mac_address=clean_mac,
        gateway_id=gateway_id,
        cabin_order=payload.cabin_order,
        label=label,
        paper_level=initial_paper,
        battery=initial_battery,
        status=initial_status
    )
    db.add(dev)
    db.commit()
    db.refresh(dev)

    discovery_service.remove_saved_client(clean_mac)

    return {
        "id": dev.id,
        "mac_address": dev.mac_address,
        "cabin_order": dev.cabin_order,
        "label": dev.label,
        "gateway_id": dev.gateway_id,
        "status": dev.status
    }

@router.put("/devices/{device_id}")
def update_device(device_id: int, payload: DeviceUpdate, db: Session = Depends(get_db)):
    dev = db.query(Device).filter(Device.id == device_id).first()
    if not dev:
        raise HTTPException(status_code=404, detail="Không tìm thấy thiết bị")

    if payload.label is not None:
        dev.label = payload.label.strip()
    if payload.cabin_order is not None:
        dev.cabin_order = payload.cabin_order
    if payload.mac_address is not None:
        clean_mac = payload.mac_address.strip().upper()
        # Check duplicate
        dup = db.query(Device).filter(Device.mac_address == clean_mac, Device.id != device_id).first()
        if dup:
            raise HTTPException(status_code=400, detail=f"Địa chỉ MAC '{clean_mac}' đã được sử dụng bởi thiết bị khác")
        dev.mac_address = clean_mac
    if payload.gateway_id is not None:
        gw = db.query(Gateway).filter(Gateway.id == payload.gateway_id).first()
        if not gw:
            raise HTTPException(status_code=404, detail="Không tìm thấy Gateway để gán")
        dev.gateway_id = payload.gateway_id

    db.commit()
    db.refresh(dev)
    return {
        "id": dev.id,
        "label": dev.label,
        "mac_address": dev.mac_address,
        "cabin_order": dev.cabin_order,
        "gateway_id": dev.gateway_id
    }

@router.delete("/devices/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_db)):
    dev = db.query(Device).filter(Device.id == device_id).first()
    if not dev:
        raise HTTPException(status_code=404, detail="Không tìm thấy thiết bị")

    db.delete(dev)
    db.commit()
    return {"message": "Đã xoá thiết bị thành công"}

# ================= PAPER ROLL SETTINGS =================
@router.get("/settings/paper")
def get_paper_roll_settings(db: Session = Depends(get_db)):
    from services.paper_service import get_paper_settings
    return get_paper_settings()

@router.put("/settings/paper")
def update_paper_roll_settings(payload: dict, db: Session = Depends(get_db)):
    from services.paper_service import update_paper_settings
    updated = update_paper_settings(db, payload)
    return {
        "status": "success",
        "message": "Đã cập nhật thông số cuộn giấy thành công!",
        "settings": updated
    }
