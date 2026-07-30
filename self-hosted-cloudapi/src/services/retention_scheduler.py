"""Background loop that applies each user's retention policy on a schedule.

An in-process asyncio task rather than a cron entry or a worker process: this is
a single-container deployment, the sweep is a handful of DELETEs, and adding a
scheduler dependency to run it would be more machinery than the job is worth.

Two properties matter here and are deliberate:

- **It only ever acts on policies that are switched on.** A user who has never
  opened the settings page has a disabled policy and is never touched.
- **A failure never kills the loop.** Anything raised by a sweep is logged and
  the loop waits for the next interval, because an API server must not lose a
  background task to one bad row and then silently stop sweeping forever.
"""

import asyncio
import logging

from config.settings import settings
from src.database import async_session_factory
from src.services.retention_service import sweep_all_enabled

logger = logging.getLogger(__name__)


async def run_retention_loop() -> None:
    """Sweep every enabled policy, then sleep, forever."""
    interval = max(1, settings.retention_sweep_hours) * 3600

    # Never on the very first tick: startup is when the schema is being
    # reconciled and the first requests are arriving, and a sweep is not urgent.
    await asyncio.sleep(interval)

    while True:
        try:
            async with async_session_factory() as db:
                count = await sweep_all_enabled(db)
                await db.commit()
            if count:
                logger.info("[retention] swept %s enabled polic(ies)", count)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Logged and swallowed on purpose — see the module docstring.
            logger.exception("[retention] sweep cycle failed; will retry next interval")
        await asyncio.sleep(interval)
