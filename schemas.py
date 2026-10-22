from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field

# --- User & Auth ---
class UserLogin(BaseModel):
    username: str
    password: str

class UserChangePassword(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6)
    role: str = Field(default="operator", pattern="^(admin|operator)$")

class UserUpdate(BaseModel):
    role: Optional[str] = Field(None, pattern="^(admin|operator)$")
    new_password: Optional[str] = Field(None, min_length=6)

class UserOut(BaseModel):
    id: int
    username: str
    role: str
    must_change_password: bool
    created_at: datetime

    class Config:
        from_attributes = True

# --- Gateway Ingestion ---
class DeviceReportItem(BaseModel):
    mac: str = Field(..., description="Device MAC address")
    distance: Optional[float] = Field(None, description="Raw distance measured by sensor in mm")
    distance_mm: Optional[float] = Field(None, description="Alias for distance (mm)")
    paper_level: Optional[float] = Field(None, ge=0, le=100, description="Paper level percentage (0-100)")
    sensor_status: Optional[int] = Field(0, description="Sensor status code (0: OK, 1: Out of range, -1: Error)")
    battery: float = Field(default=100.0, ge=0, le=100, description="Battery percentage (0-100)")

class GatewayReportRequest(BaseModel):
    gateway_mac: Optional[str] = Field(None, description="Hardware MAC address of the gateway (Địa chỉ MAC cứng)")
    gateway_id: Optional[str] = Field(None, description="Alias for gateway_mac or hardware ID")
    gateway_code: Optional[str] = Field(None, description="Alias for gateway_mac")
    gateway_ip: Optional[str] = Field(None, description="Current IP address of reporting gateway")
    devices: List[DeviceReportItem] = Field(default=[], description="List of reporting ESP client devices")

# --- Toilet & Gateway CRUD ---
class ToiletCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    floor_id: int
    x: float = Field(default=0.5, ge=0.0, le=1.0)
    y: float = Field(default=0.5, ge=0.0, le=1.0)
    gateway_mac: Optional[str] = None
    gateway_code: Optional[str] = None
    gateway_ip: Optional[str] = None
    paper_profile_id: Optional[int] = None

class ToiletUpdate(BaseModel):
    name: Optional[str] = None
    x: Optional[float] = Field(None, ge=0.0, le=1.0)
    y: Optional[float] = Field(None, ge=0.0, le=1.0)
    gateway_mac: Optional[str] = None
    gateway_code: Optional[str] = None
    gateway_ip: Optional[str] = None
    paper_profile_id: Optional[int] = None

class GatewayCreate(BaseModel):
    mac_address: str = Field(..., min_length=5, max_length=50)
    gateway_code: Optional[str] = None
    ip_address: Optional[str] = None

class GatewayUpdate(BaseModel):
    mac_address: Optional[str] = Field(None, min_length=5, max_length=50)
    gateway_code: Optional[str] = None
    ip_address: Optional[str] = None

class DeviceCreate(BaseModel):
    mac_address: str = Field(..., min_length=5, max_length=50)
    gateway_id: Optional[int] = None
    toilet_id: Optional[int] = None
    cabin_order: int = Field(default=1, ge=1)
    label: Optional[str] = None
    paper_profile_id: Optional[int] = None

class DeviceUpdate(BaseModel):
    label: Optional[str] = None
    gateway_id: Optional[int] = None
    cabin_order: Optional[int] = None
    mac_address: Optional[str] = None
    paper_profile_id: Optional[int] = None

class PaperProfileCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    is_default: Optional[bool] = False
    empty_distance_mm: float = 160.0
    roll_thickness_mm: float = 110.0
    sensor_offset_mm: float = 40.0
    warn_low_cm: float = 1.5
    warn_low_uses: float = 60.0
    warn_mid_cm: float = 1.0
    warn_mid_uses: float = 35.0
    warn_empty_cm: float = 0.5
    warn_empty_uses: float = 15.0

class PaperProfileUpdate(BaseModel):
    name: Optional[str] = None
    is_default: Optional[bool] = None
    empty_distance_mm: Optional[float] = None
    roll_thickness_mm: Optional[float] = None
    sensor_offset_mm: Optional[float] = None
    warn_low_cm: Optional[float] = None
    warn_low_uses: Optional[float] = None
    warn_mid_cm: Optional[float] = None
    warn_mid_uses: Optional[float] = None
    warn_empty_cm: Optional[float] = None
    warn_empty_uses: Optional[float] = None

class PaperAssignmentRequest(BaseModel):
    target_type: str  # "toilet" or "device"
    target_id: int
    profile_id: Optional[int] = None

# --- Responses ---
class DeviceOut(BaseModel):
    id: int
    mac_address: str
    cabin_order: int
    label: str
    paper_level: float
    battery: float
    status: str
    last_seen: Optional[datetime]

    class Config:
        from_attributes = True

class ToiletDetailOut(BaseModel):
    id: int
    name: str
    floor_id: int
    floor_name: str
    terminal_name: str
    x: float
    y: float
    gateway_id: Optional[int]
    gateway_ip: Optional[str]
    status: str
    devices: List[DeviceOut]

class StatusHistoryItem(BaseModel):
    timestamp: datetime
    paper_level: float
    status: str

    class Config:
        from_attributes = True

class AlertOut(BaseModel):
    id: int
    device_id: int
    device_label: str
    toilet_id: int
    toilet_name: str
    floor_name: str
    terminal_name: str
    type: str
    created_at: datetime
    acknowledged_by: Optional[str]
    acknowledged_at: Optional[datetime]

class FloorOut(BaseModel):
    id: int
    terminal_id: int
    terminal_name: str
    name: str
    map_pdf_path: Optional[str]
    toilet_count: int

class TerminalOut(BaseModel):
    id: int
    name: str
    floors: List[FloorOut]

class TerminalCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)

class TerminalUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)

class FloorCreate(BaseModel):
    terminal_id: int
    name: str = Field(..., min_length=1, max_length=100)

class FloorUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    terminal_id: Optional[int] = None
