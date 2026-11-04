"""Fast JSON responses without deprecated FastAPI wrapper classes."""

from typing import override

import orjson
from pydantic import JsonValue
from starlette.responses import Response


class FastJSONResponse(Response):
    """Use orjson for untyped payloads; Pydantic responses keep their typed serializer."""

    media_type: str | None = "application/json"

    @override
    def render(self, content: JsonValue) -> bytes:
        """Serialize only JSON-compatible output values."""
        return orjson.dumps(content)
