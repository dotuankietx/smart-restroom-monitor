from typing import Dict, Any, List, Optional
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from database import SessionLocal
from models import PaperProfile, Toilet, Device, SystemSetting

DEFAULT_SETTINGS: Dict[str, float] = {
    "empty_distance_mm": 160.0,
    "roll_thickness_mm": 110.0,
    "sensor_offset_mm": 40.0,
    "warn_low_cm": 1.5,
    "warn_low_uses": 60.0,
    "warn_mid_cm": 1.0,
    "warn_mid_uses": 35.0,
    "warn_empty_cm": 0.5,
    "warn_empty_uses": 15.0,
}

_cached_settings: Dict[str, float] = dict(DEFAULT_SETTINGS)

def ensure_default_profile(db: Optional[Session] = None) -> PaperProfile:
    """Ensure at least one default PaperProfile exists in the database"""
    close_db = False
    if db is None:
        db = SessionLocal()
        close_db = True
    try:
        default_prof = db.query(PaperProfile).filter(PaperProfile.is_default == True).first()
        if not default_prof:
            # Check if any profile exists
            first_prof = db.query(PaperProfile).first()
            if first_prof:
                first_prof.is_default = True
                default_prof = first_prof
            else:
                default_prof = PaperProfile(
                    name="Cấu hình mặc định toàn hệ thống",
                    is_default=True,
                    empty_distance_mm=DEFAULT_SETTINGS["empty_distance_mm"],
                    roll_thickness_mm=DEFAULT_SETTINGS["roll_thickness_mm"],
                    sensor_offset_mm=DEFAULT_SETTINGS["sensor_offset_mm"],
                    warn_low_cm=DEFAULT_SETTINGS["warn_low_cm"],
                    warn_low_uses=DEFAULT_SETTINGS["warn_low_uses"],
                    warn_mid_cm=DEFAULT_SETTINGS["warn_mid_cm"],
                    warn_mid_uses=DEFAULT_SETTINGS["warn_mid_uses"],
                    warn_empty_cm=DEFAULT_SETTINGS["warn_empty_cm"],
                    warn_empty_uses=DEFAULT_SETTINGS["warn_empty_uses"],
                )
                db.add(default_prof)
            db.commit()
            db.refresh(default_prof)
        return default_prof
    finally:
        if close_db:
            db.close()

def profile_to_dict(p: PaperProfile, db: Optional[Session] = None) -> Dict[str, Any]:
    toilet_cnt = 0
    device_cnt = 0
    if db:
        toilet_cnt = db.query(Toilet).filter(Toilet.paper_profile_id == p.id).count()
        device_cnt = db.query(Device).filter(Device.paper_profile_id == p.id).count()
    return {
        "id": p.id,
        "name": p.name,
        "is_default": bool(p.is_default),
        "empty_distance_mm": float(p.empty_distance_mm),
        "roll_thickness_mm": float(p.roll_thickness_mm),
        "sensor_offset_mm": float(p.sensor_offset_mm),
        "warn_low_cm": float(p.warn_low_cm),
        "warn_low_uses": float(p.warn_low_uses),
        "warn_mid_cm": float(p.warn_mid_cm),
        "warn_mid_uses": float(p.warn_mid_uses),
        "warn_empty_cm": float(p.warn_empty_cm),
        "warn_empty_uses": float(p.warn_empty_uses),
        "assigned_toilets_count": toilet_cnt,
        "assigned_devices_count": device_cnt,
        "created_at": p.created_at.isoformat() if p.created_at else None
    }

def get_all_profiles(db: Session) -> List[Dict[str, Any]]:
    """Return all paper profiles with counts of assigned toilets and devices"""
    ensure_default_profile(db)
    profiles = db.query(PaperProfile).order_by(PaperProfile.is_default.desc(), PaperProfile.id.asc()).all()
    return [profile_to_dict(p, db) for p in profiles]

def get_profile_by_id(db: Session, profile_id: int) -> Optional[PaperProfile]:
    return db.query(PaperProfile).filter(PaperProfile.id == profile_id).first()

def create_profile(db: Session, data: Dict[str, Any]) -> PaperProfile:
    name = (data.get("name") or "").strip()
    if not name:
        name = "Cấu hình cuộn giấy mới"
    is_default = bool(data.get("is_default", False))
    if is_default:
        db.query(PaperProfile).update({PaperProfile.is_default: False})

    p = PaperProfile(
        name=name,
        is_default=is_default,
        empty_distance_mm=float(data.get("empty_distance_mm", DEFAULT_SETTINGS["empty_distance_mm"])),
        roll_thickness_mm=float(data.get("roll_thickness_mm", DEFAULT_SETTINGS["roll_thickness_mm"])),
        sensor_offset_mm=float(data.get("sensor_offset_mm", DEFAULT_SETTINGS["sensor_offset_mm"])),
        warn_low_cm=float(data.get("warn_low_cm", DEFAULT_SETTINGS["warn_low_cm"])),
        warn_low_uses=float(data.get("warn_low_uses", DEFAULT_SETTINGS["warn_low_uses"])),
        warn_mid_cm=float(data.get("warn_mid_cm", DEFAULT_SETTINGS["warn_mid_cm"])),
        warn_mid_uses=float(data.get("warn_mid_uses", DEFAULT_SETTINGS["warn_mid_uses"])),
        warn_empty_cm=float(data.get("warn_empty_cm", DEFAULT_SETTINGS["warn_empty_cm"])),
        warn_empty_uses=float(data.get("warn_empty_uses", DEFAULT_SETTINGS["warn_empty_uses"])),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p

def update_profile(db: Session, profile_id: int, data: Dict[str, Any]) -> PaperProfile:
    p = get_profile_by_id(db, profile_id)
    if not p:
        raise ValueError("Không tìm thấy cấu hình cuộn giấy")

    if "name" in data and data["name"]:
        p.name = str(data["name"]).strip()
    if "is_default" in data and bool(data["is_default"]):
        db.query(PaperProfile).filter(PaperProfile.id != profile_id).update({PaperProfile.is_default: False})
        p.is_default = True

    for field in [
        "empty_distance_mm", "roll_thickness_mm", "sensor_offset_mm",
        "warn_low_cm", "warn_low_uses", "warn_mid_cm", "warn_mid_uses",
        "warn_empty_cm", "warn_empty_uses"
    ]:
        if field in data and data[field] is not None:
            setattr(p, field, float(data[field]))

    db.commit()
    db.refresh(p)
    return p

def set_default_profile(db: Session, profile_id: int) -> PaperProfile:
    p = get_profile_by_id(db, profile_id)
    if not p:
        raise ValueError("Không tìm thấy cấu hình")
    db.query(PaperProfile).update({PaperProfile.is_default: False})
    p.is_default = True
    db.commit()
    db.refresh(p)
    return p

def delete_profile(db: Session, profile_id: int) -> bool:
    p = get_profile_by_id(db, profile_id)
    if not p:
        return False
    if p.is_default:
        total = db.query(PaperProfile).count()
        if total <= 1:
            raise ValueError("Không thể xóa cấu hình mặc định duy nhất của hệ thống")
        # designate another profile as default
        alt = db.query(PaperProfile).filter(PaperProfile.id != profile_id).first()
        if alt:
            alt.is_default = True

    # Detach from toilets and devices (fallback to default)
    db.query(Toilet).filter(Toilet.paper_profile_id == profile_id).update({Toilet.paper_profile_id: None})
    db.query(Device).filter(Device.paper_profile_id == profile_id).update({Device.paper_profile_id: None})
    db.delete(p)
    db.commit()
    return True

def get_effective_settings_for_device(
    db: Session,
    device: Optional[Device] = None,
    toilet: Optional[Toilet] = None
) -> Dict[str, float]:
    """
    Resolve effective paper settings using hierarchical priority:
    1. Cabin (Device) specific profile
    2. WC (Toilet) specific profile
    3. Global Default profile
    """
    profile: Optional[PaperProfile] = None

    # 1. Device level
    if device and device.paper_profile_id:
        profile = db.query(PaperProfile).filter(PaperProfile.id == device.paper_profile_id).first()

    # 2. Toilet level
    if not profile:
        target_toilet = toilet
        if not target_toilet and device and device.gateway and device.gateway.toilet:
            target_toilet = device.gateway.toilet
        if target_toilet and target_toilet.paper_profile_id:
            profile = db.query(PaperProfile).filter(PaperProfile.id == target_toilet.paper_profile_id).first()

    # 3. Global Default level
    if not profile:
        profile = db.query(PaperProfile).filter(PaperProfile.is_default == True).first()
    if not profile:
        profile = ensure_default_profile(db)

    return {
        "empty_distance_mm": float(profile.empty_distance_mm),
        "roll_thickness_mm": float(profile.roll_thickness_mm),
        "sensor_offset_mm": float(profile.sensor_offset_mm),
        "warn_low_cm": float(profile.warn_low_cm),
        "warn_low_uses": float(profile.warn_low_uses),
        "warn_mid_cm": float(profile.warn_mid_cm),
        "warn_mid_uses": float(profile.warn_mid_uses),
        "warn_empty_cm": float(profile.warn_empty_cm),
        "warn_empty_uses": float(profile.warn_empty_uses),
    }

def get_paper_settings(db: Optional[Session] = None) -> Dict[str, float]:
    """Backwards compatible: Return global default paper settings"""
    close_db = False
    if db is None:
        db = SessionLocal()
        close_db = True
    try:
        p = ensure_default_profile(db)
        s = {
            "empty_distance_mm": float(p.empty_distance_mm),
            "roll_thickness_mm": float(p.roll_thickness_mm),
            "sensor_offset_mm": float(p.sensor_offset_mm),
            "warn_low_cm": float(p.warn_low_cm),
            "warn_low_uses": float(p.warn_low_uses),
            "warn_mid_cm": float(p.warn_mid_cm),
            "warn_mid_uses": float(p.warn_mid_uses),
            "warn_empty_cm": float(p.warn_empty_cm),
            "warn_empty_uses": float(p.warn_empty_uses),
        }
        _cached_settings.update(s)
        return s
    finally:
        if close_db:
            db.close()

def update_paper_settings(db: Session, new_settings: Dict[str, float]) -> Dict[str, float]:
    """Backwards compatible: Update the default profile and SystemSetting"""
    p = ensure_default_profile(db)
    for field in [
        "empty_distance_mm", "roll_thickness_mm", "sensor_offset_mm",
        "warn_low_cm", "warn_low_uses", "warn_mid_cm", "warn_mid_uses",
        "warn_empty_cm", "warn_empty_uses"
    ]:
        if field in new_settings:
            val = float(new_settings[field])
            setattr(p, field, val)
            _cached_settings[field] = val
            row = db.query(SystemSetting).filter(SystemSetting.key == field).first()
            if not row:
                db.add(SystemSetting(key=field, value=str(val)))
            else:
                row.value = str(val)
    db.commit()
    db.refresh(p)
    return get_paper_settings(db)

def load_settings_from_db(db: Optional[Session] = None) -> Dict[str, float]:
    close_db = False
    if db is None:
        db = SessionLocal()
        close_db = True
    try:
        p = ensure_default_profile(db)
        for k, v in DEFAULT_SETTINGS.items():
            row = db.query(SystemSetting).filter(SystemSetting.key == k).first()
            if not row:
                db.add(SystemSetting(key=k, value=str(getattr(p, k, v))))
            else:
                try:
                    val = float(row.value)
                    setattr(p, k, val)
                except ValueError:
                    pass
        db.commit()
        return get_paper_settings(db)
    finally:
        if close_db:
            db.close()

def _estimate_uses(thick_cm: float, cfg: Dict[str, float]) -> int:
    warn_empty_cm = cfg.get("warn_empty_cm", 0.5)
    warn_empty_uses = cfg.get("warn_empty_uses", 15.0)
    warn_mid_cm = cfg.get("warn_mid_cm", 1.0)
    warn_mid_uses = cfg.get("warn_mid_uses", 35.0)
    warn_low_cm = cfg.get("warn_low_cm", 1.5)
    warn_low_uses = cfg.get("warn_low_uses", 60.0)

    if thick_cm <= 0.0:
        return 0
    if thick_cm <= warn_empty_cm:
        return round((thick_cm / max(0.01, warn_empty_cm)) * warn_empty_uses)
    if thick_cm <= warn_mid_cm:
        span_cm = max(0.01, warn_mid_cm - warn_empty_cm)
        span_uses = warn_mid_uses - warn_empty_uses
        return round(warn_empty_uses + ((thick_cm - warn_empty_cm) / span_cm) * span_uses)
    if thick_cm <= warn_low_cm:
        span_cm = max(0.01, warn_low_cm - warn_mid_cm)
        span_uses = warn_low_uses - warn_mid_uses
        return round(warn_mid_uses + ((thick_cm - warn_mid_cm) / span_cm) * span_uses)
    return round(warn_low_uses + ((thick_cm - warn_low_cm) / 0.5) * 25.0)

def calculate_paper_metrics(
    distance_mm: Optional[float],
    sensor_status: int = 0,
    settings: Optional[Dict[str, float]] = None
) -> Dict[str, Any]:
    cfg = settings if settings is not None else get_paper_settings()
    empty_dist = cfg.get("empty_distance_mm", 160.0)
    roll_thick = cfg.get("roll_thickness_mm", 110.0)
    warn_low_cm = cfg.get("warn_low_cm", 1.5)
    warn_empty_cm = cfg.get("warn_empty_cm", 0.5)

    if distance_mm is None or sensor_status != 0 or distance_mm < 0:
        return {
            "distance_mm": distance_mm,
            "remaining_thickness_mm": 0.0,
            "remaining_thickness_cm": 0.0,
            "paper_level": 0.0,
            "estimated_uses": 0,
            "status": "EMPTY"
        }

    sensor_offset = cfg.get("sensor_offset_mm", 0.0)
    adjusted_dist = max(0.0, float(distance_mm) - sensor_offset)
    full_dist = max(0.0, empty_dist - roll_thick)

    if adjusted_dist <= full_dist:
        thick_mm = roll_thick
    elif adjusted_dist >= empty_dist:
        thick_mm = 0.0
    else:
        thick_mm = empty_dist - adjusted_dist

    thick_cm = round(thick_mm / 10.0, 2)
    percent = round(min(100.0, max(0.0, (thick_mm / roll_thick) * 100.0)), 1) if roll_thick > 0 else 0.0
    est_uses = _estimate_uses(thick_cm, cfg)

    if thick_cm <= warn_empty_cm:
        status = "EMPTY"
    elif thick_cm <= warn_low_cm:
        status = "LOW"
    else:
        status = "OK"

    return {
        "distance_mm": round(adjusted_dist, 1),
        "raw_distance_mm": round(float(distance_mm), 1),
        "sensor_offset_mm": round(sensor_offset, 1),
        "remaining_thickness_mm": round(thick_mm, 1),
        "remaining_thickness_cm": thick_cm,
        "paper_level": percent,
        "estimated_uses": est_uses,
        "status": status
    }

def calculate_metrics_from_percent(
    paper_level: float,
    settings: Optional[Dict[str, float]] = None
) -> Dict[str, Any]:
    cfg = settings if settings is not None else get_paper_settings()
    roll_thick = cfg.get("roll_thickness_mm", 110.0)
    thick_mm = (max(0.0, min(100.0, float(paper_level or 0.0))) / 100.0) * roll_thick
    thick_cm = round(thick_mm / 10.0, 2)
    est_uses = _estimate_uses(thick_cm, cfg)

    return {
        "remaining_thickness_mm": round(thick_mm, 1),
        "remaining_thickness_cm": thick_cm,
        "estimated_uses": est_uses
    }

# ================= EXPORT & IMPORT =================
def export_profiles_config(db: Session) -> Dict[str, Any]:
    profiles = db.query(PaperProfile).all()
    toilets_with_custom = db.query(Toilet).filter(Toilet.paper_profile_id.isnot(None)).all()
    devices_with_custom = db.query(Device).filter(Device.paper_profile_id.isnot(None)).all()

    toilet_assignments = []
    for t in toilets_with_custom:
        fl = t.floor
        term = fl.terminal if fl else None
        toilet_assignments.append({
            "toilet_id": t.id,
            "toilet_name": t.name,
            "terminal_name": term.name if term else None,
            "floor_name": fl.name if fl else None,
            "profile_name": t.paper_profile.name if t.paper_profile else None
        })

    device_assignments = []
    for d in devices_with_custom:
        gw = d.gateway
        toilet = gw.toilet if gw else None
        device_assignments.append({
            "device_id": d.id,
            "mac_address": d.mac_address,
            "label": d.label,
            "cabin_order": d.cabin_order,
            "toilet_name": toilet.name if toilet else None,
            "profile_name": d.paper_profile.name if d.paper_profile else None
        })

    return {
        "app": "GiamSatGiayVS",
        "version": "2.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "profiles": [profile_to_dict(p, db) for p in profiles],
        "assignments": {
            "toilets": toilet_assignments,
            "devices": device_assignments
        }
    }

def import_profiles_config(db: Session, config_data: Dict[str, Any]) -> Dict[str, Any]:
    raw_profiles = config_data.get("profiles", [])
    if not isinstance(raw_profiles, list) or len(raw_profiles) == 0:
        raise ValueError("File cấu hình không chứa danh sách 'profiles' hợp lệ")

    imported_count = 0
    updated_count = 0
    name_to_profile: Dict[str, PaperProfile] = {}

    for item in raw_profiles:
        name = (item.get("name") or "").strip()
        if not name:
            continue
        existing = db.query(PaperProfile).filter(PaperProfile.name == name).first()
        if existing:
            for field in [
                "empty_distance_mm", "roll_thickness_mm", "sensor_offset_mm",
                "warn_low_cm", "warn_low_uses", "warn_mid_cm", "warn_mid_uses",
                "warn_empty_cm", "warn_empty_uses"
            ]:
                if field in item:
                    setattr(existing, field, float(item[field]))
            if "is_default" in item and item["is_default"]:
                db.query(PaperProfile).filter(PaperProfile.id != existing.id).update({PaperProfile.is_default: False})
                existing.is_default = True
            name_to_profile[name] = existing
            updated_count += 1
        else:
            new_p = PaperProfile(
                name=name,
                is_default=bool(item.get("is_default", False)),
                empty_distance_mm=float(item.get("empty_distance_mm", DEFAULT_SETTINGS["empty_distance_mm"])),
                roll_thickness_mm=float(item.get("roll_thickness_mm", DEFAULT_SETTINGS["roll_thickness_mm"])),
                sensor_offset_mm=float(item.get("sensor_offset_mm", DEFAULT_SETTINGS["sensor_offset_mm"])),
                warn_low_cm=float(item.get("warn_low_cm", DEFAULT_SETTINGS["warn_low_cm"])),
                warn_low_uses=float(item.get("warn_low_uses", DEFAULT_SETTINGS["warn_low_uses"])),
                warn_mid_cm=float(item.get("warn_mid_cm", DEFAULT_SETTINGS["warn_mid_cm"])),
                warn_mid_uses=float(item.get("warn_mid_uses", DEFAULT_SETTINGS["warn_mid_uses"])),
                warn_empty_cm=float(item.get("warn_empty_cm", DEFAULT_SETTINGS["warn_empty_cm"])),
                warn_empty_uses=float(item.get("warn_empty_uses", DEFAULT_SETTINGS["warn_empty_uses"])),
            )
            if new_p.is_default:
                db.query(PaperProfile).update({PaperProfile.is_default: False})
            db.add(new_p)
            db.flush()
            name_to_profile[name] = new_p
            imported_count += 1

    # Assignments
    assigned_toilets = 0
    assigned_devices = 0
    raw_assignments = config_data.get("assignments", {})
    if isinstance(raw_assignments, dict):
        for t_item in raw_assignments.get("toilets", []):
            p_name = t_item.get("profile_name")
            if p_name and p_name in name_to_profile:
                prof = name_to_profile[p_name]
                toilet = None
                if "toilet_id" in t_item:
                    toilet = db.query(Toilet).filter(Toilet.id == t_item["toilet_id"]).first()
                if not toilet and "toilet_name" in t_item:
                    toilet = db.query(Toilet).filter(Toilet.name == t_item["toilet_name"]).first()
                if toilet:
                    toilet.paper_profile_id = prof.id
                    assigned_toilets += 1

        for d_item in raw_assignments.get("devices", []):
            p_name = d_item.get("profile_name")
            if p_name and p_name in name_to_profile:
                prof = name_to_profile[p_name]
                dev = None
                if "mac_address" in d_item:
                    dev = db.query(Device).filter(Device.mac_address == d_item["mac_address"].strip().upper()).first()
                if not dev and "device_id" in d_item:
                    dev = db.query(Device).filter(Device.id == d_item["device_id"]).first()
                if dev:
                    dev.paper_profile_id = prof.id
                    assigned_devices += 1

    db.commit()
    return {
        "status": "success",
        "created_profiles_count": imported_count,
        "updated_profiles_count": updated_count,
        "assigned_toilets_count": assigned_toilets,
        "assigned_devices_count": assigned_devices
    }


def sync_device_metrics_for_profile_change(
    db: Session,
    toilet_ids: Optional[List[int]] = None,
    device_ids: Optional[List[int]] = None,
    profile_id: Optional[int] = None,
    all_devices: bool = False
):
    """
    Recalculates paper metrics (percentage, status, remaining thickness, estimated uses)
    for all affected devices using their stored raw_distance_mm, commits to DB,
    and broadcasts realtime STATE_UPDATE via WebSocket so the Map updates instantly.
    """
    from models import Device, Toilet, Gateway
    from services.state_service import evaluate_toilet_status, manager
    import asyncio
    from datetime import datetime, timezone
    from config import GATEWAY_OFFLINE_TIMEOUT_SECONDS

    affected_devices = set()
    if all_devices:
        affected_devices = set(db.query(Device).all())
    else:
        if device_ids:
            devs = db.query(Device).filter(Device.id.in_(device_ids)).all()
            affected_devices.update(devs)
        if toilet_ids:
            toilets = db.query(Toilet).filter(Toilet.id.in_(toilet_ids)).all()
            for t in toilets:
                if t.gateway:
                    affected_devices.update(t.gateway.devices)
        if profile_id:
            devs_p = db.query(Device).filter(Device.paper_profile_id == profile_id).all()
            affected_devices.update(devs_p)
            toilets_p = db.query(Toilet).filter(Toilet.paper_profile_id == profile_id).all()
            for t in toilets_p:
                if t.gateway:
                    for d in t.gateway.devices:
                        if not d.paper_profile_id:
                            affected_devices.add(d)
            prof = db.query(PaperProfile).filter(PaperProfile.id == profile_id).first()
            if prof and prof.is_default:
                all_devs = db.query(Device).all()
                for d in all_devs:
                    gw = d.gateway
                    toilet = gw.toilet if gw else None
                    if not d.paper_profile_id and (not toilet or not toilet.paper_profile_id):
                        affected_devices.add(d)

    affected_toilets = set()

    for dev in affected_devices:
        gw = dev.gateway
        toilet = gw.toilet if gw else None
        if toilet:
            affected_toilets.add(toilet)

        settings = get_effective_settings_for_device(db, device=dev, toilet=toilet)
        raw_dist = dev.raw_distance_mm
        if raw_dist is None:
            empty_dist = settings.get("empty_distance_mm", 160.0)
            roll_thick = settings.get("roll_thickness_mm", 110.0)
            offset = settings.get("sensor_offset_mm", 0.0)
            thick_mm = (dev.paper_level / 100.0) * roll_thick
            sensor_dist = max(0.0, empty_dist - thick_mm)
            raw_dist = sensor_dist + offset
            dev.raw_distance_mm = raw_dist

        m = calculate_paper_metrics(raw_dist, 0, settings=settings)
        dev.paper_level = m["paper_level"]
        if dev.status != "OFFLINE":
            dev.status = m["status"]

    db.commit()

    now = datetime.now(timezone.utc)
    default_p = ensure_default_profile(db)

    # Broadcast state updates for all affected toilets to update Map in realtime
    for toilet in affected_toilets:
        gw = toilet.gateway
        devices = gw.devices if gw else []
        t_status = evaluate_toilet_status(devices, gateway=gw)
        min_paper = min([d.paper_level for d in devices]) if devices else 100.0

        dev_list = []
        for d in devices:
            d_settings = get_effective_settings_for_device(db, device=d, toilet=toilet)
            m = calculate_metrics_from_percent(d.paper_level, settings=d_settings)
            dev_list.append({
                "id": d.id,
                "mac_address": d.mac_address,
                "cabin_order": d.cabin_order,
                "label": d.label,
                "paper_level": d.paper_level,
                "remaining_thickness_cm": m["remaining_thickness_cm"],
                "remaining_thickness_mm": m["remaining_thickness_mm"],
                "estimated_uses": m["estimated_uses"],
                "battery": d.battery,
                "status": d.status,
                "last_seen": d.last_seen.isoformat() if d.last_seen else None,
                "paper_profile_id": d.paper_profile_id,
                "effective_profile_name": d.paper_profile.name if d.paper_profile else (toilet.paper_profile.name if toilet.paper_profile else default_p.name),
                "source": "DEVICE" if d.paper_profile_id else ("TOILET" if toilet.paper_profile_id else "DEFAULT")
            })

        gw_online = False
        if gw and gw.last_seen:
            ls = gw.last_seen.replace(tzinfo=timezone.utc) if gw.last_seen.tzinfo is None else gw.last_seen
            gw_online = (now - ls).total_seconds() <= GATEWAY_OFFLINE_TIMEOUT_SECONDS

        effective_toilet_name = toilet.paper_profile.name if toilet.paper_profile else default_p.name

        msg = {
            "event": "STATE_UPDATE",
            "data": {
                "toilet_id": toilet.id,
                "toilet_name": toilet.name,
                "floor_id": toilet.floor_id,
                "status": t_status,
                "toilet_status": t_status,
                "toilet_min_paper": min_paper,
                "gateway_id": gw.id if gw else None,
                "gateway_mac": gw.mac_address if gw else None,
                "gateway_online": gw_online,
                "paper_profile_id": toilet.paper_profile_id,
                "paper_profile_name": toilet.paper_profile.name if toilet.paper_profile else None,
                "effective_profile_name": effective_toilet_name,
                "source": "TOILET" if toilet.paper_profile_id else "DEFAULT",
                "devices": dev_list
            }
        }
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(manager.broadcast(msg))
            else:
                loop.run_until_complete(manager.broadcast(msg))
        except Exception as e:
            pass
