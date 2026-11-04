# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend
WORKDIR /build/web
COPY work/safenight/package.json work/safenight/package-lock.json ./
RUN npm ci
COPY work/safenight/ ./
RUN npm run build

FROM python:3.12-slim AS backend
COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
COPY backend/src ./src
RUN uv sync --locked --no-dev --no-editable
COPY backend/data/training ./data/training
COPY backend/scripts/train_random_forest.py ./scripts/train_random_forest.py
RUN .venv/bin/python scripts/train_random_forest.py --output /app/models/random_forest

FROM python:3.12-slim AS runtime
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SAFENIGHT_MODEL_BUNDLE_DIR=/app/models/random_forest \
    SAFENIGHT_WEB_DIST=/app/web \
    SAFENIGHT_SENSOR_LOCATIONS_FILE=/app/var/sensor_locations.xlsx
WORKDIR /app
COPY --from=backend /app/.venv /app/.venv
COPY --from=backend /app/models /app/models
COPY --from=frontend /build/web/dist /app/web
RUN useradd --uid 10001 --create-home safenight \
    && mkdir -p /app/var \
    && chown safenight:safenight /app/var
USER safenight
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=4).read()"
CMD ["safenight", "serve", "--host", "0.0.0.0", "--port", "8000"]
