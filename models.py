from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, ForeignKey, Boolean, Text
)
from sqlalchemy.orm import relationship
from database import Base

def utc_now():
    return datetime.now(timezone.utc)

class PaperProfile(Base):
    __tablename__ = "paper_profiles"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    is_default = Column(Boolean, default=False, nullable=False)
    empty_distance_mm = Column(Float, default=160.0, nullable=False)
    roll_thickness_mm = Column(Float, default=110.0, nullable=False)
    sensor_offset_mm = Column(Float, default=40.0, nullable=False)
    warn_low_cm = Column(Float, default=1.5, nullable=False)
    warn_low_uses = Column(Float, default=60.0, nullable=False)
    warn_mid_cm = Column(Float, default=1.0, nullable=False)
    warn_mid_uses = Column(Float, default=35.0, nullable=False)
    warn_empty_cm = Column(Float, default=0.5, nullable=False)
    warn_empty_uses = Column(Float, default=15.0, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    toilets = relationship("Toilet", back_populates="paper_profile")
    devices = relationship("Device", back_populates="paper_profile")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), default="operator", nullable=False)  # "admin" | "operator"
    must_change_password = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)

class Terminal(Base):
    __tablename__ = "terminals"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), unique=True, nullable=False)  # "T2", "T3"

    floors = relationship("Floor", back_populates="terminal", cascade="all, delete-orphan")

class Floor(Base):
    __tablename__ = "floors"

    id = Column(Integer, primary_key=True, index=True)
    terminal_id = Column(Integer, ForeignKey("terminals.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    map_pdf_path = Column(String(255), nullable=True)

    terminal = relationship("Terminal", back_populates="floors")
    toilets = relationship("Toilet", back_populates="floor", cascade="all, delete-orphan")

class Toilet(Base):
    __tablename__ = "toilets"

    id = Column(Integer, primary_key=True, index=True)
    floor_id = Column(Integer, ForeignKey("floors.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    x = Column(Float, default=0.5, nullable=False)  # 0.0 to 1.0 (relative to page)
    y = Column(Float, default=0.5, nullable=False)  # 0.0 to 1.0
    gateway_id = Column(Integer, ForeignKey("gateways.id", ondelete="SET NULL"), nullable=True)
    paper_profile_id = Column(Integer, ForeignKey("paper_profiles.id", ondelete="SET NULL"), nullable=True)

    floor = relationship("Floor", back_populates="toilets")
    gateway = relationship("Gateway", back_populates="toilet", foreign_keys=[gateway_id])
    paper_profile = relationship("PaperProfile", back_populates="toilets")

class Gateway(Base):
    __tablename__ = "gateways"

    id = Column(Integer, primary_key=True, index=True)
    mac_address = Column(String(50), unique=True, index=True, nullable=True)  # Địa chỉ MAC cứng cố định của ESP32 Gateway
    gateway_code = Column(String(50), nullable=True)  # Tên gợi nhớ (vd: GW01, GW02...)
    ip_address = Column(String(45), index=True, nullable=True)  # IP hiện tại do DHCP router cấp (tự động cập nhật)
    toilet_id = Column(Integer, ForeignKey("toilets.id", ondelete="SET NULL"), nullable=True, unique=True)
    last_seen = Column(DateTime, nullable=True)

    toilet = relationship("Toilet", back_populates="gateway", foreign_keys=[Toilet.gateway_id], uselist=False)
    devices = relationship("Device", back_populates="gateway", cascade="all, delete-orphan")

class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    mac_address = Column(String(50), unique=True, index=True, nullable=False)
    gateway_id = Column(Integer, ForeignKey("gateways.id", ondelete="CASCADE"), nullable=False)
    cabin_order = Column(Integer, default=1, nullable=False)
    label = Column(String(100), default="Cabin 1", nullable=False)
    paper_level = Column(Float, default=100.0, nullable=False)  # 0 - 100
    raw_distance_mm = Column(Float, nullable=True)             # Raw distance measured by ToF sensor (mm)
    battery = Column(Float, default=100.0, nullable=False)      # 0 - 100
    status = Column(String(20), default="OK", nullable=False)   # OK | LOW | EMPTY | OFFLINE
    last_seen = Column(DateTime, nullable=True)
    paper_profile_id = Column(Integer, ForeignKey("paper_profiles.id", ondelete="SET NULL"), nullable=True)

    gateway = relationship("Gateway", back_populates="devices")
    paper_profile = relationship("PaperProfile", back_populates="devices")
    history = relationship("StatusHistory", back_populates="device", cascade="all, delete-orphan")
    alerts = relationship("Alert", back_populates="device", cascade="all, delete-orphan")

class StatusHistory(Base):
    __tablename__ = "status_history"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    paper_level = Column(Float, nullable=False)
    status = Column(String(20), nullable=False)
    timestamp = Column(DateTime, default=utc_now, nullable=False)

    device = relationship("Device", back_populates="history")

class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(20), nullable=False)  # LOW_PAPER | EMPTY | OFFLINE
    created_at = Column(DateTime, default=utc_now, nullable=False)
    acknowledged_by = Column(String(50), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)

    device = relationship("Device", back_populates="alerts")

class SystemSetting(Base):
    __tablename__ = "system_settings"

    key = Column(String(50), primary_key=True)
    value = Column(String(255), nullable=False)
