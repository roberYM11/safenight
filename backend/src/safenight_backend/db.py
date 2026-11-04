"""PostgreSQL engine and explicit transaction-scoped session factories."""

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def make_engine(url: str) -> AsyncEngine:
    """Create a bounded PostgreSQL connection pool without logging credentials."""
    connect_args = {"command_timeout": 30} if url.startswith("postgresql+asyncpg:") else {}
    return create_async_engine(
        url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        pool_timeout=10,
        connect_args=connect_args,
    )


def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Let each caller own its session and transaction lifecycle explicitly."""
    return async_sessionmaker(engine, expire_on_commit=False)
