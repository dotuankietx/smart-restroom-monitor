from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

class DiscoveryService:
    def __init__(self):
        # Key: gateway_key (ip, mac, or gw_id) -> dict of { mac_address: client_data }
        self._discovered: Dict[str, Dict[str, Any]] = {}
        self._gw_aliases: Dict[str, str] = {} # e.g. mac -> ip or ip -> mac

    def register_live_client(
        self,
        gateway_ip: str,
        mac: str,
        paper_level: float,
        battery: float,
        status: str,
        distance: Optional[float] = None,
        remaining_thickness_cm: Optional[float] = None,
        remaining_thickness_mm: Optional[float] = None,
        estimated_uses: Optional[int] = None,
        raw_data: Optional[dict] = None,
        gateway_mac: Optional[str] = None,
        gateway_id: Optional[int] = None,
        toilet_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Record an active client transmitting to this Gateway.
        Stores in-memory without persisting to database.
        If a client was previously deleted, new incoming packets will re-add it to the discovered list.
        """
        mac_key = mac.strip().upper()
        gw_key = (gateway_ip or "").strip()
        gw_mac_key = (gateway_mac or "").strip().upper() if gateway_mac else None

        primary_key = gw_key or gw_mac_key or (f"GW_{gateway_id}" if gateway_id else "unknown")
        if primary_key not in self._discovered:
            self._discovered[primary_key] = {}

        if gw_key and gw_mac_key:
            self._gw_aliases[gw_mac_key] = gw_key
            self._gw_aliases[gw_key] = gw_mac_key
        if gateway_id:
            gw_id_str = f"GW_{gateway_id}"
            if gw_key:
                self._gw_aliases[gw_id_str] = gw_key
                self._gw_aliases[gw_key] = gw_id_str
            if gw_mac_key:
                self._gw_aliases[gw_id_str] = gw_mac_key

        now_iso = datetime.now(timezone.utc).isoformat()
        client_data = {
            "mac_address": mac_key,
            "gateway_ip": gw_key,
            "gateway_mac": gw_mac_key,
            "gateway_id": gateway_id,
            "toilet_id": toilet_id,
            "distance": round(float(distance), 1) if distance is not None else None,
            "remaining_thickness_cm": round(float(remaining_thickness_cm), 2) if remaining_thickness_cm is not None else None,
            "remaining_thickness_mm": round(float(remaining_thickness_mm), 1) if remaining_thickness_mm is not None else None,
            "estimated_uses": int(estimated_uses) if estimated_uses is not None else None,
            "paper_level": round(float(paper_level), 1),
            "battery": round(float(battery), 1),
            "status": status,
            "last_seen": now_iso,
            "is_saved": False
        }
        self._discovered[primary_key][mac_key] = client_data
        return client_data

    def get_discovered_for_gateway(
        self,
        identifier: Optional[str] = None,
        mac: Optional[str] = None,
        gateway_id: Optional[int] = None,
        toilet_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Return list of live discovered clients for a given gateway IP, MAC, ID, or Toilet ID"""
        results: Dict[str, Dict[str, Any]] = {}
        clean_id = (identifier or "").strip()
        clean_mac = (mac or "").strip().upper()

        check_keys = set()
        if clean_id:
            check_keys.add(clean_id)
            check_keys.add(clean_id.upper())
            alias = self._gw_aliases.get(clean_id) or self._gw_aliases.get(clean_id.upper())
            if alias:
                check_keys.add(alias)
        if clean_mac:
            check_keys.add(clean_mac)
            alias = self._gw_aliases.get(clean_mac)
            if alias:
                check_keys.add(alias)
        if gateway_id:
            gw_id_str = f"GW_{gateway_id}"
            check_keys.add(gw_id_str)
            alias = self._gw_aliases.get(gw_id_str)
            if alias:
                check_keys.add(alias)

        # 1. Match from dictionary keys
        for k in check_keys:
            if k in self._discovered:
                for cmac, dev in self._discovered[k].items():
                    results[cmac] = dev

        # 2. Match from client attributes across all pools
        for pool_key, devs in self._discovered.items():
            for cmac, dev in devs.items():
                matched = False
                if gateway_id is not None and dev.get("gateway_id") == gateway_id:
                    matched = True
                elif toilet_id is not None and dev.get("toilet_id") == toilet_id:
                    matched = True
                elif clean_mac and dev.get("gateway_mac") and dev.get("gateway_mac").upper() == clean_mac:
                    matched = True
                elif clean_id and dev.get("gateway_ip") and dev.get("gateway_ip") == clean_id:
                    matched = True
                if matched:
                    results[cmac] = dev

        return list(results.values())

    def get_all_discovered(self) -> Dict[str, List[Dict[str, Any]]]:
        """Return all discovered clients indexed by gateway IP, MAC, gateway_id, plus '_all'"""
        by_key: Dict[str, Dict[str, Any]] = {}
        all_unique: Dict[str, Dict[str, Any]] = {}

        for pool_key, devs in self._discovered.items():
            for cmac, dev in devs.items():
                all_unique[cmac] = dev

                if pool_key not in by_key:
                    by_key[pool_key] = {}
                by_key[pool_key][cmac] = dev

                gw_mac = dev.get("gateway_mac")
                if gw_mac:
                    gw_mac_u = gw_mac.upper()
                    if gw_mac_u not in by_key:
                        by_key[gw_mac_u] = {}
                    by_key[gw_mac_u][cmac] = dev

                gw_ip = dev.get("gateway_ip")
                if gw_ip:
                    if gw_ip not in by_key:
                        by_key[gw_ip] = {}
                    by_key[gw_ip][cmac] = dev

                gw_id = dev.get("gateway_id")
                if gw_id:
                    gw_id_k = str(gw_id)
                    if gw_id_k not in by_key:
                        by_key[gw_id_k] = {}
                    by_key[gw_id_k][cmac] = dev

        res = {k: list(v.values()) for k, v in by_key.items()}
        res["_all"] = list(all_unique.values())
        return res

    def dismiss_client(self, mac: str) -> bool:
        """User explicitly deletes this discovered client from the active list.
        If the physical client sends signal again later, it will re-appear as a new discovered client.
        """
        clean_mac = mac.strip().upper()
        removed = False
        for gw, devs in list(self._discovered.items()):
            if clean_mac in devs:
                del devs[clean_mac]
                removed = True
        return True

    def remove_saved_client(self, mac: str):
        """When a client is officially saved into database, remove it from un-saved list"""
        mac_key = mac.strip().upper()
        for gw, devs in self._discovered.items():
            if mac_key in devs:
                del devs[mac_key]

    def clear_gateway(self, gateway_ip: str):
        gw_key = gateway_ip.strip()
        if gw_key in self._discovered:
            del self._discovered[gw_key]

discovery_service = DiscoveryService()
