import os
import random
from datetime import datetime, timezone
from pathlib import Path
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas
from reportlab.lib import colors

from config import UPLOAD_DIR
from database import SessionLocal, engine, Base
from models import User, Terminal, Floor, Toilet, Gateway, Device, StatusHistory
from services.auth_service import get_password_hash

import re
import unicodedata
import shutil

DEFAULT_MAPS_DIR = Path(__file__).resolve().parent / "default_maps"

DEFAULT_MAP_FILES = {
    ('T1', 'Tầng Trệt'): ('T1', 'MAT BANG GA T1-tangtret.pdf', 'default_map_t1_tang_tret.pdf'),
    ('T1', 'Tầng 1'): ('T1', 'MAT BANG GA T1-tang1.pdf', 'default_map_t1_tang_1.pdf'),
    ('T2', 'Tầng G'): ('T2', 'xref GF.pdf', 'default_map_t2_tang_g.pdf'),
    ('T2', 'Lầu 1'): ('T2', 'Xref 1F_D-Layout1.pdf', 'default_map_t2_lau_1.pdf'),
    ('T2', 'Lầu 2'): ('T2', 'xref 2F-Layout1.pdf', 'default_map_t2_lau_2.pdf'),
    ('T2', 'Lầu 3'): ('T2', 'xref 3F-Layout1.pdf', 'default_map_t2_lau_3.pdf'),
    ('T3', 'Tầng hầm'): ('T3', 'XREP.PTB-BM-Layout2.pdf', 'default_map_t3_tang_ham.pdf'),
    ('T3', 'Lầu 1'): ('T3', 'XREP.PTB-1FL-Layout3.pdf', 'default_map_t3_lau_1.pdf'),
    ('T3', 'Lầu 2'): ('T3', 'XREP.PTB-2FL-Layout2.pdf', 'default_map_t3_lau_2.pdf'),
    ('T3', 'Lầu 3'): ('T3', 'XREP.PTB-3FL-Layout2.pdf', 'default_map_t3_lau_3.pdf'),
    ('T3', 'Lầu 4'): ('T3', 'XREP.PTB-4FL-Layout2.pdf', 'default_map_t3_lau_4.pdf'),
}

def get_default_or_sample_pdf_map(terminal_name: str, floor_name: str) -> str:
    """Get the official architectural default floor plan PDF if available, otherwise generate sample"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    key = (terminal_name, floor_name)
    if key in DEFAULT_MAP_FILES:
        subfolder, src_name, target_name = DEFAULT_MAP_FILES[key]
        src_path = DEFAULT_MAPS_DIR / subfolder / src_name
        dest_path = UPLOAD_DIR / target_name
        if src_path.exists():
            if not dest_path.exists():
                shutil.copy2(src_path, dest_path)
            return f"/uploads/{target_name}"
    return generate_sample_pdf_map(terminal_name, floor_name)

def slugify(text: str) -> str:
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('utf-8')
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    return re.sub(r'[-\s]+', '_', text)

def generate_sample_pdf_map(terminal_name: str, floor_name: str) -> str:
    """Generate a clean architectural floor plan PDF for an airport terminal floor"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    clean_floor = slugify(floor_name)
    clean_term = slugify(terminal_name)
    safe_name = f"sample_map_{clean_term}_{clean_floor}.pdf"
    file_path = UPLOAD_DIR / safe_name
    
    # Check if already generated
    if file_path.exists():
        return f"/uploads/{safe_name}"

    # Create landscape canvas
    c = canvas.Canvas(str(file_path), pagesize=landscape(letter))
    width, height = landscape(letter)

    # Background
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.rect(0, 0, width, height, fill=1, stroke=0)

    # Outer Terminal Boundary Wall
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(3)
    margin = 40
    c.roundRect(margin, margin, width - 2 * margin, height - 2 * margin, radius=12, fill=0, stroke=1)

    # Title & Floor header
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 18)
    c.drawString(margin + 20, height - margin - 35, f"AIRPORT TERMINAL {terminal_name.upper()} - {floor_name.upper()}")
    
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.HexColor("#64748b"))
    c.drawString(margin + 20, height - margin - 52, "ARCHITECTURAL FLOOR PLAN & RESTROOM LOCATIONS")

    # Draw Central Concourse / Main Corridor
    c.setFillColor(colors.HexColor("#e2e8f0"))
    c.setStrokeColor(colors.HexColor("#94a3b8"))
    c.setLineWidth(1)
    c.rect(margin + 50, height/2 - 40, width - 2*margin - 100, 80, fill=1, stroke=1)

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(width / 2, height / 2 - 4, "CENTRAL PASSENGER CONCOURSE / SẢNH CHÍNH")

    # Gate zones (North)
    gate_width = 80
    gate_y = height - margin - 120
    for i, gate_num in enumerate([1, 2, 3, 4, 5, 6]):
        gx = margin + 60 + i * (gate_width + 25)
        if gx + gate_width < width - margin - 50:
            c.setFillColor(colors.HexColor("#eff6ff"))
            c.setStrokeColor(colors.HexColor("#3b82f6"))
            c.roundRect(gx, gate_y, gate_width, 50, radius=4, fill=1, stroke=1)
            c.setFillColor(colors.HexColor("#1e3a8a"))
            c.setFont("Helvetica-Bold", 10)
            c.drawCentredString(gx + gate_width/2, gate_y + 28, f"GATE {terminal_name}{gate_num:02d}")
            c.setFont("Helvetica", 8)
            c.drawCentredString(gx + gate_width/2, gate_y + 12, "Cổng khởi hành")

    # South zones: Duty Free, Security, Baggage
    sy = margin + 40
    # Zone 1
    c.setFillColor(colors.HexColor("#fef3c7"))
    c.setStrokeColor(colors.HexColor("#f59e0b"))
    c.roundRect(margin + 60, sy, 160, 65, radius=4, fill=1, stroke=1)
    c.setFillColor(colors.HexColor("#92400e"))
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(margin + 140, sy + 38, "DUTY FREE & RETAIL")
    c.setFont("Helvetica", 8)
    c.drawCentredString(margin + 140, sy + 20, "Khu mua sắm miễn thuế")

    # Zone 2
    c.setFillColor(colors.HexColor("#ecfdf5"))
    c.setStrokeColor(colors.HexColor("#10b981"))
    c.roundRect(width/2 - 100, sy, 200, 65, radius=4, fill=1, stroke=1)
    c.setFillColor(colors.HexColor("#065f46"))
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(width/2, sy + 38, "SECURITY CHECK & LOUNGE")
    c.setFont("Helvetica", 8)
    c.drawCentredString(width/2, sy + 20, "Soi chiếu an ninh & Phòng chờ")

    # Zone 3
    c.setFillColor(colors.HexColor("#f1f5f9"))
    c.setStrokeColor(colors.HexColor("#64748b"))
    c.roundRect(width - margin - 220, sy, 160, 65, radius=4, fill=1, stroke=1)
    c.setFillColor(colors.HexColor("#334155"))
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(width - margin - 140, sy + 38, "INFORMATION & SERVICE")
    c.setFont("Helvetica", 8)
    c.drawCentredString(width - margin - 140, sy + 20, "Quầy thông tin hàng không")

    # Designated Restroom Zones (Visual guidance on floor plan)
    restroom_spots = [
        (margin + 100, height/2 + 55, "RESTROOM A (WEST)"),
        (width/2 - 50, height/2 + 55, "RESTROOM B (CENTER)"),
        (width - margin - 180, height/2 + 55, "RESTROOM C (EAST)")
    ]
    for rx, ry, rlabel in restroom_spots:
        c.setFillColor(colors.HexColor("#e0f2fe"))
        c.setStrokeColor(colors.HexColor("#0284c7"))
        c.roundRect(rx, ry, 110, 42, radius=4, fill=1, stroke=1)
        c.setFillColor(colors.HexColor("#0369a1"))
        c.setFont("Helvetica-Bold", 8)
        c.drawCentredString(rx + 55, ry + 24, "TOILET AREA")
        c.setFont("Helvetica", 7)
        c.drawCentredString(rx + 55, ry + 10, rlabel)

    # Watermark / Scale
    c.setFont("Helvetica", 8)
    c.setFillColor(colors.HexColor("#94a3b8"))
    c.drawRightString(width - margin - 20, margin + 15, "Scale 1:500 | Airport Facilities Management System")
    
    c.showPage()
    c.save()
    return f"/uploads/{safe_name}"

def init_system_defaults():
    """Create initial admin account, default terminals, floors, and paper settings if empty"""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # 0. Initialize default paper settings
        from services.paper_service import load_settings_from_db
        load_settings_from_db(db)

        # 1. Admin account: admin / admin123
        admin_user = db.query(User).filter(User.username == "admin").first()
        if not admin_user:
            admin_user = User(
                username="admin",
                password_hash=get_password_hash("admin123"),
                role="admin",
                must_change_password=True,
                created_at=datetime.now(timezone.utc)
            )
            db.add(admin_user)
            print("[Init] Created default admin account: admin / admin123 (must_change_password=True)")

        # 2. Terminals & Floors
        # Terminal T1 (Mặc định: Tầng Trệt, Tầng 1)
        t1 = db.query(Terminal).filter(Terminal.name == "T1").first()
        if not t1:
            t1 = Terminal(name="T1")
            db.add(t1)
            db.flush()
            for fname in ["Tầng Trệt", "Tầng 1"]:
                pdf_url = get_default_or_sample_pdf_map("T1", fname)
                floor = Floor(terminal_id=t1.id, name=fname, map_pdf_path=pdf_url)
                db.add(floor)
            print("[Init] Seeded Terminal T1 with 2 floors (Tầng Trệt, Tầng 1)")

        t2 = db.query(Terminal).filter(Terminal.name == "T2").first()
        if not t2:
            t2 = Terminal(name="T2")
            db.add(t2)
            db.flush()
            # T2: Tầng G, Lầu 1, Lầu 2, Lầu 3
            for fname in ["Tầng G", "Lầu 1", "Lầu 2", "Lầu 3"]:
                pdf_url = get_default_or_sample_pdf_map("T2", fname)
                floor = Floor(terminal_id=t2.id, name=fname, map_pdf_path=pdf_url)
                db.add(floor)
            print("[Init] Seeded Terminal T2 with 4 floors (Tầng G, Lầu 1, 2, 3)")

        t3 = db.query(Terminal).filter(Terminal.name == "T3").first()
        if not t3:
            t3 = Terminal(name="T3")
            db.add(t3)
            db.flush()
            # T3: 1 tầng hầm, lầu 1, lầu 2, lầu 3, lầu 4
            for fname in ["Tầng hầm", "Lầu 1", "Lầu 2", "Lầu 3", "Lầu 4"]:
                pdf_url = get_default_or_sample_pdf_map("T3", fname)
                floor = Floor(terminal_id=t3.id, name=fname, map_pdf_path=pdf_url)
                db.add(floor)
            print("[Init] Seeded Terminal T3 with 5 floors")

        db.commit()
    except Exception as e:
        db.rollback()
        print(f"[Init Error] {e}")
    finally:
        db.close()

def seed_demo_toilets_and_devices():
    """Seed ~3 toilets per floor, dummy gateways and devices"""
    init_system_defaults()
    db = SessionLocal()
    try:
        floors = db.query(Floor).all()
        # Relative coordinates matching the floor plan spots
        positions = [
            (0.24, 0.40, "WC Khu A - Cánh Tây"),
            (0.50, 0.40, "WC Khu B - Trung Tâm"),
            (0.76, 0.40, "WC Khu C - Cánh Đông")
        ]

        now = datetime.now(timezone.utc)
        gw_counter = 10

        for floor in floors:
            existing_toilets = db.query(Toilet).filter(Toilet.floor_id == floor.id).count()
            if existing_toilets >= 3:
                continue

            for idx, (x, y, loc_name) in enumerate(positions):
                gw_ip = f"192.168.{floor.id + 10}.{gw_counter}"
                gw_counter += 1

                # Check or create Gateway
                gateway = db.query(Gateway).filter(Gateway.ip_address == gw_ip).first()
                if not gateway:
                    gateway = Gateway(ip_address=gw_ip, last_seen=now)
                    db.add(gateway)
                    db.flush()

                toilet = Toilet(
                    floor_id=floor.id,
                    name=f"{loc_name} ({floor.terminal.name} - {floor.name})",
                    x=x,
                    y=y,
                    gateway_id=gateway.id
                )
                db.add(toilet)
                db.flush()
                gateway.toilet_id = toilet.id

                # Create 3-4 devices per gateway
                num_devices = random.choice([3, 4])
                for d_i in range(1, num_devices + 1):
                    mac = f"AA:BB:{floor.id:02X}:{toilet.id:02X}:{d_i:02X}:99"
                    dev = db.query(Device).filter(Device.mac_address == mac).first()
                    if not dev:
                        paper_lvl = random.choice([85.0, 70.0, 45.0, 25.0, 8.0])
                        status = "OK"
                        if paper_lvl <= 10:
                            status = "EMPTY"
                        elif paper_lvl <= 30:
                            status = "LOW"

                        dev = Device(
                            mac_address=mac,
                            gateway_id=gateway.id,
                            cabin_order=d_i,
                            label=f"Cabin {d_i}",
                            paper_level=paper_lvl,
                            battery=random.randint(85, 100),
                            status=status,
                            last_seen=now
                        )
                        db.add(dev)
                        db.flush()

                        # Initial history
                        hist = StatusHistory(
                            device_id=dev.id,
                            paper_level=dev.paper_level,
                            status=dev.status,
                            timestamp=now
                        )
                        db.add(hist)

        db.commit()
        print("[Demo Seed] Successfully populated sample toilets, gateways, and devices!")
    except Exception as e:
        db.rollback()
        print(f"[Demo Seed Error] {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_demo_toilets_and_devices()
