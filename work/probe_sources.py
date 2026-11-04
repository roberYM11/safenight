# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx2[http2,brotli,zstd]", "python-dotenv"]
# ///
# Run: uv run work/probe_sources.py
"""Probe only the authorized providers; never emit URLs or credential content."""

import json
import socket
from pathlib import Path

import httpx2
from dotenv import dotenv_values


def main() -> None:
    """Print bounded nonsecret provider responses for capability detection."""
    config = dotenv_values(Path(__file__).parents[1] / "backend/.env")
    limits = httpx2.Limits(max_connections=200, max_keepalive_connections=40, keepalive_expiry=30)
    timeout = httpx2.Timeout(connect=5, read=30, write=10, pool=10)
    transport = httpx2.HTTPTransport(http2=True, retries=3, limits=limits,
                                   socket_options=[(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)])
    with httpx2.Client(transport=transport, timeout=timeout, follow_redirects=False) as client:
        try:
            key = config["SAFENIGHT_SDOT_API_KEY"]
            response = client.get(f"http://openapi.seoul.go.kr:8088/{key}/json/sDoTEnv/1/2/")
            print("sdot_http_status", response.status_code)
            print("sdot_response", response.text[:7000])
        except httpx2.HTTPError as error:
            print("sdot_transport_error", type(error).__name__)
        try:
            response = client.get("https://apis.data.go.kr/1741000/cctv_info/info", params={
                "serviceKey": config["SAFENIGHT_CCTV_API_KEY"], "pageNo": "1",
                "numOfRows": "2", "returnType": "JSON",
            })
            print("cctv_http_status", response.status_code)
            print("cctv_response", response.text[:6000])
        except httpx2.HTTPError as error:
            print("cctv_transport_error", type(error).__name__)


if __name__ == "__main__":
    main()
