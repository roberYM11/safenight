"""Bounded provider HTTP client with credential-safe observability."""

import logging
import socket
from typing import Final

import httpx2

LOGGER: Final = logging.getLogger(__name__)


async def response_log(response: httpx2.Response) -> None:
    """Record provider host and status, excluding secret paths and query strings."""
    LOGGER.info(
        "provider_response",
        extra={
            "provider_host": response.request.url.host,
            "http_status": response.status_code,
        },
    )


def create_client() -> httpx2.AsyncClient:
    """Use timeouts, pooling, connect retries and TCP_NODELAY for provider calls."""
    limits = httpx2.Limits(
        max_connections=200,
        max_keepalive_connections=40,
        keepalive_expiry=30,
    )
    transport = httpx2.AsyncHTTPTransport(
        http2=True,
        retries=3,
        limits=limits,
        socket_options=[(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)],
    )
    return httpx2.AsyncClient(
        transport=transport,
        timeout=httpx2.Timeout(connect=5, read=30, write=10, pool=10),
        follow_redirects=False,
        event_hooks={"response": [response_log]},
    )
