import os
import shutil
import time
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy.orm import Session

from config import UPLOAD_DIR, MAX_FILE_SIZE_BYTES, ALLOWED_EXTENSIONS
from database import get_db
from models import User, Terminal, Floor, Toilet, Gateway, Device, StatusHistory, Alert
from schemas import (
    PaperProfileCreate, PaperProfileUpdate, PaperAssignmentRequest,
    UserCreate, UserUpdate, UserOut, ToiletCreate, ToiletUpdate, DeviceCreate, DeviceUpdate, TerminalCreate, TerminalUpdate, FloorCreate, FloorUpdate, GatewayCreate, GatewayUpdate
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


# ================= TERMINAL & FLOOR MANAGEMENT =================
@router.get("/terminals")
def list_admin_terminals(db: Session = Depends(get_db)):
    from routers.dashboard import resolve_floor_map_image
    terminals = db.query(Terminal).order_by(Terminal.name).all()
    results = []
    
    def floor_order_key(name: str) -> int:
        import re
        n = name.lower()
        if "hầm" in n or "ham" in n:
            return -1
        if "g" in n or "trệt" in n or "tret" in n:
            return 0
        match = re.search(r'\d+', n)
        if match:
            return int(match.group())
        return 99

    for t in terminals:
        floors_data = []
        for f in t.floors:
            toilets_cnt = db.query(Toilet).filter(Toilet.floor_id == f.id).count()
            floors_data.append({
                "id": f.id,
                "name": f.name,
                "terminal_id": t.id,
                "terminal_name": t.name,
                "map_pdf_path": f.map_pdf_path,
                "map_image_path": resolve_floor_map_image(f.map_pdf_path),
                "toilet_count": toilets_cnt
            })
        floors_data.sort(key=lambda x: floor_order_key(x["name"]))
        results.append({
            "id": t.id,
            "name": t.name,
            "floor_count": len(t.floors),
            "toilet_count": sum(fl["toilet_count"] for fl in floors_data),
            "floors": floors_data
        })
    return results

@router.post("/terminals")
def create_terminal(payload: TerminalCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tên nhà ga không được để trống")
    exist = db.query(Terminal).filter(Terminal.name.ilike(name)).first()
    if exist:
        raise HTTPException(status_code=400, detail=f"Nhà ga '{name}' đã tồn tại")
    terminal = Terminal(name=name)
    db.add(terminal)
    db.commit()
    db.refresh(terminal)
    return {"id": terminal.id, "name": terminal.name, "message": f"Đã thêm nhà ga {name} thành công"}

@router.put("/terminals/{terminal_id}")
def update_terminal(terminal_id: int, payload: TerminalUpdate, db: Session = Depends(get_db)):
    terminal = db.query(Terminal).filter(Terminal.id == terminal_id).first()
    if not terminal:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà ga")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tên nhà ga không được để trống")
    exist = db.query(Terminal).filter(Terminal.name.ilike(name), Terminal.id != terminal_id).first()
    if exist:
        raise HTTPException(status_code=400, detail=f"Tên nhà ga '{name}' đã được sử dụng")
    terminal.name = name
    db.commit()
    return {"id": terminal.id, "name": terminal.name, "message": "Đã cập nhật nhà ga thành công"}

@router.delete("/terminals/{terminal_id}")
def delete_terminal(terminal_id: int, db: Session = Depends(get_db)):
    terminal = db.query(Terminal).filter(Terminal.id == terminal_id).first()
    if not terminal:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà ga")
    
    # Unlink any gateways from toilets in this terminal
    for fl in terminal.floors:
        for tl in fl.toilets:
            if tl.gateway:
                tl.gateway.toilet_id = None

    db.delete(terminal)
    db.commit()
    return {"message": f"Đã xóa nhà ga {terminal.name} và toàn bộ tầng, nhà vệ sinh liên quan"}

@router.post("/floors")
def create_floor(payload: FloorCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tên tầng không được để trống")
    term = db.query(Terminal).filter(Terminal.id == payload.terminal_id).first()
    if not term:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà ga đã chọn")
    exist = db.query(Floor).filter(Floor.terminal_id == payload.terminal_id, Floor.name.ilike(name)).first()
    if exist:
        raise HTTPException(status_code=400, detail=f"Tầng '{name}' đã tồn tại trong nhà ga {term.name}")
    floor = Floor(terminal_id=payload.terminal_id, name=name)
    db.add(floor)
    db.commit()
    db.refresh(floor)
    return {"id": floor.id, "name": floor.name, "terminal_id": floor.terminal_id, "message": f"Đã thêm tầng {name} vào nhà ga {term.name}"}

@router.put("/floors/{floor_id}")
def update_floor(floor_id: int, payload: FloorUpdate, db: Session = Depends(get_db)):
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Không tìm thấy tầng")
    
    target_term_id = payload.terminal_id if payload.terminal_id is not None else floor.terminal_id
    term = db.query(Terminal).filter(Terminal.id == target_term_id).first()
    if not term:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà ga")

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Tên tầng không được để trống")
        exist = db.query(Floor).filter(Floor.terminal_id == target_term_id, Floor.name.ilike(name), Floor.id != floor_id).first()
        if exist:
            raise HTTPException(status_code=400, detail=f"Tầng '{name}' đã tồn tại trong nhà ga {term.name}")
        floor.name = name

    if payload.terminal_id is not None:
        floor.terminal_id = payload.terminal_id

    db.commit()
    return {"id": floor.id, "name": floor.name, "terminal_id": floor.terminal_id, "message": "Đã cập nhật tầng thành công"}

@router.delete("/floors/{floor_id}")
def delete_floor(floor_id: int, db: Session = Depends(get_db)):
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Không tìm thấy tầng")
    
    # Unlink any gateways from toilets on this floor
    for tl in floor.toilets:
        if tl.gateway:
            tl.gateway.toilet_id = None

    db.delete(floor)
    db.commit()
    return {"message": f"Đã xóa tầng {floor.name} và toàn bộ nhà vệ sinh thuộc tầng"}

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

    # Automatically generate high-resolution image for instant client map rendering
    jpg_filename = f"map_floor_{floor_id}_{int(time.time())}.jpg"
    try:
        import fitz
        doc = fitz.open(file_path)
        if len(doc) > 0:
            pix = doc[0].get_pixmap(dpi=150)
            pix.save(str(UPLOAD_DIR / jpg_filename))
    except Exception as e:
        print(f"[UploadMap] Warning rasterizing map: {e}")

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
    target_gw_mac = (payload.gateway_mac or "").strip().upper()
    target_gw_ip = (payload.gateway_ip or "").strip()

    if target_gw_mac:
        gateway = db.query(Gateway).filter(
            (Gateway.mac_address == target_gw_mac) | (Gateway.gateway_code == target_gw_mac)
        ).first()
        if not gateway:
            gateway = Gateway(mac_address=target_gw_mac, ip_address=target_gw_ip or None)
            db.add(gateway)
            db.flush()
    elif target_gw_ip:
        gateway = db.query(Gateway).filter(Gateway.ip_address == target_gw_ip).first()
        if not gateway:
            gateway = Gateway(ip_address=target_gw_ip)
            db.add(gateway)
            db.flush()

    if gateway and gateway.toilet_id:
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
        "gateway_id": gateway.id if gateway else None,
        "gateway_mac": gateway.mac_address if gateway else None,
        "gateway_ip": gateway.ip_address if gateway else None
    }

@router.put("/toilets/{toilet_id}")
def update_toilet(toilet_id: int, payload: ToiletUpdate, db: Session = Depends(get_db)):
    toilet = db.query(Toilet).filter(Toilet.id == toilet_id).first()
    if not toilet:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")

    if payload.name is not None:
        toilet.name = payload.name.strip()
    if payload.paper_profile_id is not None:
        toilet.paper_profile_id = payload.paper_profile_id if payload.paper_profile_id > 0 else None
    if payload.x is not None:
        toilet.x = payload.x
    if payload.y is not None:
        toilet.y = payload.y

    if payload.gateway_mac is not None or payload.gateway_ip is not None:
        target_gw_mac = (payload.gateway_mac or "").strip().upper()
        target_gw_ip = (payload.gateway_ip or "").strip()

        gateway = None
        if target_gw_mac:
            gateway = db.query(Gateway).filter(
                (Gateway.mac_address == target_gw_mac) | (Gateway.gateway_code == target_gw_mac)
            ).first()
            if not gateway:
                gateway = Gateway(mac_address=target_gw_mac, ip_address=target_gw_ip or None)
                db.add(gateway)
                db.flush()
        elif target_gw_ip:
            gateway = db.query(Gateway).filter(Gateway.ip_address == target_gw_ip).first()
            if not gateway:
                gateway = Gateway(ip_address=target_gw_ip)
                db.add(gateway)
                db.flush()

        if gateway:
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
    from services.paper_service import sync_device_metrics_for_profile_change
    sync_device_metrics_for_profile_change(db, toilet_ids=[toilet.id])
    return {
        "id": toilet.id,
        "name": toilet.name,
        "floor_id": toilet.floor_id,
        "x": toilet.x,
        "y": toilet.y,
        "gateway_id": toilet.gateway.id if toilet.gateway else None,
        "gateway_mac": toilet.gateway.mac_address if toilet.gateway else None,
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

        toilet_status = None
        toilet_min_paper = None
        if toilet:
            from services.state_service import evaluate_toilet_status
            toilet_status = evaluate_toilet_status(gw.devices, gateway=gw)
            if gw.devices:
                toilet_min_paper = min([d.paper_level for d in gw.devices])
            else:
                toilet_min_paper = 100.0 if is_online else 0.0

        dev_list = []
        for d in sorted(gw.devices, key=lambda x: (x.cabin_order if x.cabin_order is not None else 999, x.id)):
            dev_ls = d.last_seen
            if dev_ls and dev_ls.tzinfo is None:
                dev_ls = dev_ls.replace(tzinfo=timezone.utc)
            dev_list.append({
                "id": d.id,
                "mac_address": d.mac_address,
                "cabin_order": d.cabin_order,
                "label": d.label,
                "gateway_id": d.gateway_id,
                "toilet_id": toilet.id if toilet else None,
                "toilet_name": toilet.name if toilet else "Chưa gán",
                "paper_level": d.paper_level,
                "battery": d.battery,
                "status": d.status,
                "last_seen": dev_ls.isoformat() if dev_ls else None
            })

        from services.discovery_service import discovery_service
        raw_disc = discovery_service.get_discovered_for_gateway(
            identifier=gw.ip_address,
            mac=gw.mac_address,
            gateway_id=gw.id,
            toilet_id=gw.toilet_id
        )
        saved_gw_macs = {d.mac_address.upper() for d in gw.devices if d.mac_address}
        unsaved_disc = [d for d in raw_disc if d["mac_address"].upper() not in saved_gw_macs]

        results.append({
            "id": gw.id,
            "mac_address": gw.mac_address or f"30:AE:A4:07:0F:{gw.id:02X}",
            "gateway_code": gw.gateway_code or f"GW{gw.id:02d}",
            "ip_address": gw.ip_address,
            "toilet_id": toilet.id if toilet else None,
            "toilet_name": toilet.name if toilet else "Chưa gán",
            "toilet_status": toilet_status,
            "toilet_min_paper": toilet_min_paper,
            "terminal_name": terminal.name if terminal else "—",
            "floor_name": floor.name if floor else "—",
            "last_seen": gw.last_seen.isoformat() if gw.last_seen else None,
            "device_count": len(gw.devices),
            "devices": dev_list,
            "discovered_devices": unsaved_disc,
            "is_new": is_new,
            "is_online": is_online,
            "status": "ONLINE" if is_online else "OFFLINE"
        })
    return results

@router.delete("/gateways/discovered/{mac_address}")
async def admin_delete_discovered_client(mac_address: str, db: Session = Depends(get_db)):
    from services.discovery_service import discovery_service
    from services.state_service import manager
    clean_mac = mac_address.strip().upper()
    discovery_service.dismiss_client(clean_mac)
    await manager.broadcast({
        "event": "DISCOVERED_CLIENT_DELETED",
        "data": {
            "mac_address": clean_mac
        }
    })
    return {"status": "success", "message": f"Client {clean_mac} đã được xóa thành công"}

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

    # Logic kiểm tra trạng thái Gateway chuẩn xác:
    # 1. Nếu Gateway vừa gửi dữ liệu trong khoảng thời gian timeout (elapsed <= GATEWAY_OFFLINE_TIMEOUT_SECONDS):
    #    -> Gateway chắc chắn ĐANG HOẠT ĐỘNG (ONLINE)!
    # 2. Hoặc nếu máy tính ping được ICMP tới IP của Gateway:
    #    -> Gateway chắc chắn ĐANG HOẠT ĐỘNG (ONLINE)!
    final_online = is_online or is_reachable

    if final_online:
        if minutes_ago == 0:
            time_desc = f"{seconds_ago} giây trước"
        else:
            time_desc = f"{minutes_ago} phút {seconds_ago} giây trước"
        msg = f"Đang hoạt động tốt! (Gói tin gần nhất: {time_desc}, lúc {last_seen_str})"
        
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
        if minutes_ago == 0:
            time_desc = f"{seconds_ago} giây"
        else:
            time_desc = f"{minutes_ago} phút"
        msg = f"Đã mất kết nối trong {time_desc} qua (Lần liên lạc cuối: lúc {last_seen_str})"

        for d in gw.devices:
            d.status = "OFFLINE"
        db.commit()

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

        if is_online or is_reachable:
            final_online = True
            online_count += 1
            from services.state_service import evaluate_device_status
            for d in gw.devices:
                d.status = evaluate_device_status(d.paper_level, d.last_seen)
        else:
            final_online = False
            offline_count += 1
            for d in gw.devices:
                d.status = "OFFLINE"


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
def create_gateway(
    payload: Optional[GatewayCreate] = None,
    mac_address: Optional[str] = None,
    ip_address: Optional[str] = None,
    db: Session = Depends(get_db)
):
    target_mac = None
    target_ip = None
    target_code = None

    if payload:
        target_mac = payload.mac_address.strip().upper() if payload.mac_address else None
        target_ip = payload.ip_address.strip() if payload.ip_address else None
        target_code = payload.gateway_code.strip() if payload.gateway_code else None
    if not target_mac and mac_address:
        target_mac = mac_address.strip().upper()
    if not target_ip and ip_address:
        target_ip = ip_address.strip()

    if not target_mac and not target_ip:
        raise HTTPException(status_code=400, detail="Vui lòng nhập địa chỉ MAC cứng hoặc IP của Gateway")

    if not target_mac and target_ip:
        target_mac = f"GW_{target_ip.replace('.', '_')}"

    existing = db.query(Gateway).filter(Gateway.mac_address == target_mac).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Gateway với MAC '{target_mac}' đã tồn tại")

    gw = Gateway(mac_address=target_mac, gateway_code=target_code, ip_address=target_ip)
    db.add(gw)
    db.commit()
    db.refresh(gw)
    return {
        "id": gw.id,
        "mac_address": gw.mac_address,
        "gateway_code": gw.gateway_code,
        "ip_address": gw.ip_address
    }

@router.put("/gateways/{gateway_id}")
def update_gateway(gateway_id: int, payload: GatewayUpdate, db: Session = Depends(get_db)):
    gw = db.query(Gateway).filter(Gateway.id == gateway_id).first()
    if not gw:
        raise HTTPException(status_code=404, detail="Không tìm thấy Gateway")
    
    if payload.mac_address is not None:
        mac = payload.mac_address.strip().upper()
        if not mac:
            raise HTTPException(status_code=400, detail="Địa chỉ MAC không được để trống")
        existing = db.query(Gateway).filter(Gateway.mac_address == mac, Gateway.id != gateway_id).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"Địa chỉ MAC '{mac}' đã được sử dụng bởi Gateway khác")
        gw.mac_address = mac

    if payload.gateway_code is not None:
        gw.gateway_code = payload.gateway_code.strip() or None

    if payload.ip_address is not None:
        gw.ip_address = payload.ip_address.strip() or None

    db.commit()
    return {"id": gw.id, "mac_address": gw.mac_address, "gateway_code": gw.gateway_code, "ip_address": gw.ip_address}

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
        status=initial_status,
        paper_profile_id=payload.paper_profile_id if (payload.paper_profile_id and payload.paper_profile_id > 0) else None
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
    if payload.paper_profile_id is not None:
        dev.paper_profile_id = payload.paper_profile_id if payload.paper_profile_id > 0 else None
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
    from services.paper_service import sync_device_metrics_for_profile_change
    sync_device_metrics_for_profile_change(db, device_ids=[dev.id])
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
    from services.paper_service import update_paper_settings, sync_device_metrics_for_profile_change
    updated = update_paper_settings(db, payload)
    sync_device_metrics_for_profile_change(db, all_devices=True)
    return {
        "status": "success",
        "message": "Đã cập nhật thông số cuộn giấy thành công!",
        "settings": updated
    }


# ================= PAPER ROLL MULTI-PROFILE & ASSIGNMENTS =================
@router.get("/paper/profiles")
def list_paper_profiles(db: Session = Depends(get_db)):
    from services.paper_service import get_all_profiles
    return get_all_profiles(db)

@router.post("/paper/profiles")
def create_new_paper_profile(payload: PaperProfileCreate, db: Session = Depends(get_db)):
    from services.paper_service import create_profile, profile_to_dict
    p = create_profile(db, payload.dict())
    return profile_to_dict(p, db)

@router.put("/paper/profiles/{profile_id}")
def update_existing_paper_profile(profile_id: int, payload: PaperProfileUpdate, db: Session = Depends(get_db)):
    from services.paper_service import update_profile, profile_to_dict
    try:
        p = update_profile(db, profile_id, payload.dict(exclude_unset=True))
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, profile_id=profile_id)
        return profile_to_dict(p, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/paper/profiles/{profile_id}")
def delete_existing_paper_profile(profile_id: int, db: Session = Depends(get_db)):
    from services.paper_service import delete_profile
    try:
        success = delete_profile(db, profile_id)
        if not success:
            raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình cuộn giấy")
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, all_devices=True)
        return {"status": "success", "message": "Đã xóa cấu hình cuộn giấy thành công"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/paper/profiles/{profile_id}/set-default")
def set_paper_profile_as_default(profile_id: int, db: Session = Depends(get_db)):
    from services.paper_service import set_default_profile, profile_to_dict
    try:
        p = set_default_profile(db, profile_id)
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, all_devices=True)
        return profile_to_dict(p, db)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.get("/paper/assignments")
def get_paper_assignments(db: Session = Depends(get_db)):
    from services.paper_service import ensure_default_profile
    default_p = ensure_default_profile(db)
    terminals = db.query(Terminal).all()
    result = []
    for term in terminals:
        t_floors = []
        for fl in term.floors:
            fl_toilets = []
            for t in fl.toilets:
                t_prof = t.paper_profile
                t_effective_name = t_prof.name if t_prof else f"{default_p.name} (Mặc định)"
                
                cabins = []
                devices = t.gateway.devices if t.gateway else []
                for d in sorted(devices, key=lambda x: (x.cabin_order or 999, x.id)):
                    d_prof = d.paper_profile
                    if d_prof:
                        source = "DEVICE"
                        eff_name = d_prof.name
                    elif t_prof:
                        source = "TOILET"
                        eff_name = f"{t_prof.name} (Theo WC)"
                    else:
                        source = "DEFAULT"
                        eff_name = f"{default_p.name} (Mặc định)"

                    cabins.append({
                        "device_id": d.id,
                        "label": d.label,
                        "cabin_order": d.cabin_order,
                        "mac_address": d.mac_address,
                        "paper_profile_id": d.paper_profile_id,
                        "paper_profile_name": d_prof.name if d_prof else None,
                        "effective_profile_id": d_prof.id if d_prof else (t_prof.id if t_prof else default_p.id),
                        "effective_profile_name": eff_name,
                        "source": source
                    })

                fl_toilets.append({
                    "toilet_id": t.id,
                    "toilet_name": t.name,
                    "paper_profile_id": t.paper_profile_id,
                    "paper_profile_name": t_prof.name if t_prof else None,
                    "effective_profile_id": t_prof.id if t_prof else default_p.id,
                    "effective_profile_name": t_effective_name,
                    "source": "TOILET" if t_prof else "DEFAULT",
                    "cabins": cabins
                })

            t_floors.append({
                "floor_id": fl.id,
                "floor_name": fl.name,
                "toilets": fl_toilets
            })

        result.append({
            "terminal_id": term.id,
            "terminal_name": term.name,
            "floors": t_floors
        })
    return result

@router.post("/paper/assign")
def assign_paper_profile(payload: PaperAssignmentRequest, db: Session = Depends(get_db)):
    from models import PaperProfile
    if payload.target_type == "toilet":
        toilet = db.query(Toilet).filter(Toilet.id == payload.target_id).first()
        if not toilet:
            raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")
        if payload.profile_id and payload.profile_id > 0:
            prof = db.query(PaperProfile).filter(PaperProfile.id == payload.profile_id).first()
            if not prof:
                raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình cuộn giấy")
            toilet.paper_profile_id = prof.id
        else:
            toilet.paper_profile_id = None
        db.commit()
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, toilet_ids=[toilet.id])
        return {"status": "success", "message": f"Đã cập nhật cấu hình cho WC {toilet.name}"}

    elif payload.target_type == "device":
        device = db.query(Device).filter(Device.id == payload.target_id).first()
        if not device:
            raise HTTPException(status_code=404, detail="Không tìm thấy thiết bị cabin")
        if payload.profile_id and payload.profile_id > 0:
            prof = db.query(PaperProfile).filter(PaperProfile.id == payload.profile_id).first()
            if not prof:
                raise HTTPException(status_code=404, detail="Không tìm thấy cấu hình cuộn giấy")
            device.paper_profile_id = prof.id
        else:
            device.paper_profile_id = None
        db.commit()
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, device_ids=[device.id])
        return {"status": "success", "message": f"Đã cập nhật cấu hình cho cabin {device.label}"}
    else:
        raise HTTPException(status_code=400, detail="Loại mục tiêu không hợp lệ")

@router.get("/paper/export")
def export_paper_profiles(db: Session = Depends(get_db)):
    from services.paper_service import export_profiles_config
    return export_profiles_config(db)

@router.post("/paper/import")
def import_paper_profiles(payload: dict, db: Session = Depends(get_db)):
    from services.paper_service import import_profiles_config
    try:
        result = import_profiles_config(db, payload)
        from services.paper_service import sync_device_metrics_for_profile_change
        sync_device_metrics_for_profile_change(db, all_devices=True)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
