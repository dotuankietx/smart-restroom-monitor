from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from database import get_db
from models import Terminal, Floor, Toilet, Gateway, Device, StatusHistory, Alert
from schemas import (
    TerminalOut, FloorOut, ToiletDetailOut, DeviceOut, StatusHistoryItem
)
from services.auth_service import require_operator_or_admin
from services.state_service import evaluate_toilet_status

router = APIRouter(prefix="/api", tags=["dashboard"])

def resolve_floor_map_image(map_pdf_path: Optional[str]) -> Optional[str]:
    if not map_pdf_path:
        return None
    from config import UPLOAD_DIR
    from pathlib import Path
    pdf_rel = map_pdf_path.replace('/uploads/', '').strip()
    if not pdf_rel:
        return None
    jpg_name = Path(pdf_rel).stem + '.jpg'
    jpg_file = UPLOAD_DIR / jpg_name
    if not jpg_file.exists():
        try:
            import fitz
            pdf_file = UPLOAD_DIR / pdf_rel
            if pdf_file.exists():
                doc = fitz.open(pdf_file)
                if len(doc) > 0:
                    pix = doc[0].get_pixmap(dpi=150)
                    pix.save(str(jpg_file))
        except Exception as e:
            print(f'[MapRender] Error rendering {pdf_rel} to image: {e}')
    if jpg_file.exists():
        return f'/uploads/{jpg_name}'
    return None



@router.get("/terminals")
def list_terminals(
    db: Session = Depends(get_db),
    user = Depends(require_operator_or_admin)
):
    terminals = db.query(Terminal).all()
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

    for term in terminals:
        floors_data = []
        for fl in term.floors:
            toilet_count = db.query(Toilet).filter(Toilet.floor_id == fl.id).count()
            floors_data.append({
                "id": fl.id,
                "terminal_id": term.id,
                "terminal_name": term.name,
                "name": fl.name,
                "map_pdf_path": fl.map_pdf_path,
                "map_image_path": resolve_floor_map_image(fl.map_pdf_path),
                "toilet_count": toilet_count
            })
        floors_data.sort(key=lambda x: floor_order_key(x["name"]))
        results.append({
            "id": term.id,
            "name": term.name,
            "floors": floors_data
        })
    return results

@router.get("/floors/{floor_id}")
def get_floor_details(
    floor_id: int,
    db: Session = Depends(get_db),
    user = Depends(require_operator_or_admin)
):
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Không tìm thấy tầng được yêu cầu")

    toilets_data = []
    now = datetime.now(timezone.utc)
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS
    from services.paper_service import ensure_default_profile
    default_p = ensure_default_profile(db)
    for t in floor.toilets:
        devices = t.gateway.devices if t.gateway else []
        t_status = evaluate_toilet_status(devices, gateway=t.gateway)
        min_paper = min([d.paper_level for d in devices]) if devices else 100.0

        gw = t.gateway
        gw_online = False
        if gw and gw.last_seen:
            ls = gw.last_seen.replace(tzinfo=timezone.utc) if gw.last_seen.tzinfo is None else gw.last_seen
            gw_online = (now - ls).total_seconds() <= GATEWAY_OFFLINE_TIMEOUT_SECONDS

        t_eff_name = t.paper_profile.name if t.paper_profile else default_p.name
        toilets_data.append({
            "id": t.id,
            "name": t.name,
            "x": t.x,
            "y": t.y,
            "status": t_status,
            "min_paper": min_paper,
            "gateway_id": gw.id if gw else None,
            "gateway_mac": gw.mac_address if gw else None,
            "gateway_code": gw.gateway_code if gw else None,
            "gateway_ip": gw.ip_address if gw else None,
            "gateway_online": gw_online,
            "paper_profile_id": t.paper_profile_id,
            "paper_profile_name": t.paper_profile.name if t.paper_profile else None,
            "effective_profile_name": t_eff_name,
            "source": "TOILET" if t.paper_profile_id else "DEFAULT",
            "gateway_last_seen": gw.last_seen.isoformat() if (gw and gw.last_seen) else None,
            "device_count": len(devices)
        })

    return {
        "id": floor.id,
        "name": floor.name,
        "terminal_id": floor.terminal_id,
        "terminal_name": floor.terminal.name,
        "map_pdf_path": floor.map_pdf_path,
        "map_image_path": resolve_floor_map_image(floor.map_pdf_path),
        "toilets": toilets_data
    }

@router.get("/toilets/{toilet_id}")
def get_toilet_detail(
    toilet_id: int,
    db: Session = Depends(get_db),
    user = Depends(require_operator_or_admin)
):
    toilet = db.query(Toilet).filter(Toilet.id == toilet_id).first()
    if not toilet:
        raise HTTPException(status_code=404, detail="Không tìm thấy nhà vệ sinh")

    devices = toilet.gateway.devices if toilet.gateway else []
    sorted_devices = sorted(devices, key=lambda d: (d.cabin_order if d.cabin_order is not None else 999, d.id))
    t_status = evaluate_toilet_status(devices, gateway=toilet.gateway)

    gw = toilet.gateway
    gw_ip = gw.ip_address if gw else None
    gw_online = False
    gw_last_seen = None
    if gw and gw.last_seen:
        now = datetime.now(timezone.utc)
        ls = gw.last_seen.replace(tzinfo=timezone.utc) if gw.last_seen.tzinfo is None else gw.last_seen
        from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS
        gw_online = (now - ls).total_seconds() <= GATEWAY_OFFLINE_TIMEOUT_SECONDS
        gw_last_seen = gw.last_seen.isoformat()

    from services.discovery_service import discovery_service
    discovered = []
    if gw:
        raw_disc = discovery_service.get_discovered_for_gateway(
            identifier=gw_ip,
            mac=gw.mac_address,
            gateway_id=gw.id,
            toilet_id=toilet.id
        )
        saved_macs = {d.mac_address.upper() for d in devices if d.mac_address}
        discovered = [d for d in raw_disc if d["mac_address"].upper() not in saved_macs]

    from services.paper_service import ensure_default_profile, get_effective_settings_for_device, calculate_metrics_from_percent
    default_p = ensure_default_profile(db)
    toilet_effective_name = toilet.paper_profile.name if toilet.paper_profile else default_p.name

    devices_list = []
    for d in sorted_devices:
        d_settings = get_effective_settings_for_device(db, device=d, toilet=toilet)
        m = calculate_metrics_from_percent(d.paper_level, settings=d_settings)
        d_eff_name = d.paper_profile.name if d.paper_profile else toilet_effective_name
        d_source = "DEVICE" if d.paper_profile_id else ("TOILET" if toilet.paper_profile_id else "DEFAULT")

        devices_list.append({
            "id": d.id,
            "mac_address": d.mac_address,
            "cabin_order": d.cabin_order if d.cabin_order is not None else 1,
            "label": d.label,
            "paper_level": d.paper_level,
            "remaining_thickness_cm": m["remaining_thickness_cm"],
            "remaining_thickness_mm": m["remaining_thickness_mm"],
            "estimated_uses": m["estimated_uses"],
            "battery": d.battery,
            "status": "OFFLINE" if not gw_online else d.status,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None,
            "paper_profile_id": d.paper_profile_id,
            "paper_profile_name": d.paper_profile.name if d.paper_profile else None,
            "effective_profile_name": d_eff_name,
            "source": d_source
        })

    return {
        "id": toilet.id,
        "name": toilet.name,
        "floor_id": toilet.floor_id,
        "floor_name": toilet.floor.name,
        "terminal_name": toilet.floor.terminal.name,
        "x": toilet.x,
        "y": toilet.y,
        "gateway_id": gw.id if gw else None,
        "gateway_mac": gw.mac_address if gw else None,
        "gateway_code": gw.gateway_code if gw else None,
        "gateway_ip": gw_ip,
        "gateway_online": gw_online,
        "gateway_last_seen": gw_last_seen,
        "paper_profile_id": toilet.paper_profile_id,
        "paper_profile_name": toilet.paper_profile.name if toilet.paper_profile else None,
        "effective_profile_name": toilet_effective_name,
        "source": "TOILET" if toilet.paper_profile_id else "DEFAULT",
        "status": t_status,
        "devices": devices_list,
        "discovered_devices": discovered
    }

@router.get("/settings/paper")
def get_public_paper_settings(user = Depends(require_operator_or_admin)):
    from services.paper_service import get_paper_settings
    return get_paper_settings()

@router.get("/gateways/discovered")
def get_discovered_clients(
    ip: Optional[str] = Query(None),
    user = Depends(require_operator_or_admin)
):
    from services.discovery_service import discovery_service
    if ip and ip.strip():
        return discovery_service.get_discovered_for_gateway(ip.strip())
    return discovery_service.get_all_discovered()

@router.delete("/gateways/discovered/{mac_address}")
async def delete_discovered_client(
    mac_address: str,
    user = Depends(require_operator_or_admin)
):
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

@router.get("/devices/{device_id}/history", response_model=List[StatusHistoryItem])
def get_device_history(
    device_id: int,
    limit: int = 50,
    db: Session = Depends(get_db),
    user = Depends(require_operator_or_admin)
):
    history = db.query(StatusHistory).filter(
        StatusHistory.device_id == device_id
    ).order_by(desc(StatusHistory.timestamp)).limit(limit).all()
    
    # Return chronological order for charts
    return list(reversed(history))

@router.get("/summary")
def get_airport_summary(
    terminal_id: Optional[int] = Query(None),
    floor_id: Optional[int] = Query(None),
    status_filter: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user = Depends(require_operator_or_admin)
):
    query = db.query(Toilet)
    if floor_id:
        query = query.filter(Toilet.floor_id == floor_id)
    elif terminal_id:
        query = query.join(Floor).filter(Floor.terminal_id == terminal_id)

    toilets = query.all()
    results = []

    severity_order = {"EMPTY": 0, "LOW": 1, "OFFLINE": 2, "OK": 3}

    for t in toilets:
        devices = t.gateway.devices if t.gateway else []
        t_status = evaluate_toilet_status(devices, gateway=t.gateway)

        if status_filter and status_filter.upper() != "ALL" and t_status != status_filter.upper():
            continue

        min_paper = min([d.paper_level for d in devices]) if devices else 100.0
        
        # Count active unack alerts for this toilet
        device_ids = [d.id for d in devices]
        unack_alerts_count = db.query(Alert).filter(
            Alert.device_id.in_(device_ids),
            Alert.acknowledged_at == None
        ).count() if device_ids else 0

        results.append({
            "id": t.id,
            "name": t.name,
            "terminal_name": t.floor.terminal.name,
            "terminal_id": t.floor.terminal_id,
            "floor_name": t.floor.name,
            "floor_id": t.floor_id,
            "gateway_mac": t.gateway.mac_address if t.gateway else "Chưa gán",
            "gateway_ip": t.gateway.ip_address if t.gateway else "Chưa gán",
            "device_count": len(devices),
            "status": t_status,
            "min_paper": min_paper,
            "unack_alerts_count": unack_alerts_count,
            "severity": severity_order.get(t_status, 4),
            "x": t.x,
            "y": t.y
        })

    # Sort primarily by severity (EMPTY first), then by terminal and name
    results.sort(key=lambda item: (item["severity"], item["terminal_name"], item["name"]))
    return results
