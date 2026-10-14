import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'app.db'}")

# Security & Auth
SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-airport-toilet-key-2026-xyz")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

# Gateway Ingestion
GATEWAY_API_KEY = os.getenv("GATEWAY_API_KEY", "airport-gateway-secret-api-key-2026")

# Thresholds & Timeouts
PAPER_THRESHOLD_OK = 30     # > 30 is OK
PAPER_THRESHOLD_LOW = 10    # 10 < paper <= 30 is LOW, <= 10 is EMPTY
OFFLINE_TIMEOUT_SECONDS = int(os.getenv("OFFLINE_TIMEOUT_SECONDS", "120"))
OFFLINE_CHECK_INTERVAL_SECONDS = int(os.getenv("OFFLINE_CHECK_INTERVAL_SECONDS", "15"))

# Cấu hình quy đổi khoảng cách cảm biến ToF (VL53L0X) mm -> phần trăm giấy (%)
# - DIST_FULL_MM: Khoảng cách khi cuộn giấy ĐẦY (100%) - 150 mm
# - DIST_EMPTY_MM: Khoảng cách khi cuộn giấy HẾT (0%) - 300 mm
DIST_FULL_MM = int(os.getenv("DIST_FULL_MM", "150"))
DIST_EMPTY_MM = int(os.getenv("DIST_EMPTY_MM", "300"))

def calculate_paper_percent(distance_mm: float, sensor_status: int = 0) -> float:
    """
    Server phân tích và quy đổi khoảng cách (mm) sang % giấy còn lại:
    - sensor_status != 0: Lỗi cảm biến hoặc ngoài tầm đo -> trả về 0.0%
    - distance <= DIST_FULL_MM: Cuộn giấy đầy (100.0%)
    - distance >= DIST_EMPTY_MM: Cuộn giấy hết (0.0%)
    - Ở giữa: Tuyến tính theo công thức
    """
    if sensor_status != 0 or distance_mm < 0:
        return 0.0
    if distance_mm <= DIST_FULL_MM:
        return 100.0
    if distance_mm >= DIST_EMPTY_MM:
        return 0.0
    percent = (DIST_EMPTY_MM - distance_mm) / (DIST_EMPTY_MM - DIST_FULL_MM) * 100.0
    return max(0.0, min(100.0, round(float(percent), 1)))

# Uploads
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(BASE_DIR / "uploads")))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024  # 20MB
ALLOWED_EXTENSIONS = {".pdf"}
