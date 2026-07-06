import pathlib
import sys

import duckdb
import pytest

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from agentx_memory.config import MemoryConfig, bootstrap  # noqa: E402
from agentx_memory.ingestion.embedding import MockEmbedder  # noqa: E402
from agentx_memory.ingestion.pipeline import IngestionPipeline  # noqa: E402


@pytest.fixture()
def cfg(tmp_path) -> MemoryConfig:
    return bootstrap(MemoryConfig(data_dir=tmp_path / "mem"))


@pytest.fixture()
def conn(cfg):
    c = duckdb.connect(str(cfg.db_path))
    yield c
    c.close()


@pytest.fixture()
def embedder() -> MockEmbedder:
    return MockEmbedder()


@pytest.fixture()
def pipeline(cfg, conn, embedder) -> IngestionPipeline:
    return IngestionPipeline(cfg, conn, embedder=embedder)


SAMPLE_MD = """# Employment Contract
## Termination
### Notice periods
The employer must give four weeks notice before dismissal. The employee must give two weeks notice in writing.
## Salary
Salary is paid monthly on the 25th at a rate of 4500 GBP. Overtime is compensated at 1.5x.
"""


@pytest.fixture()
def ingested_doc(pipeline):
    return pipeline.ingest_text(SAMPLE_MD, "contract.md", "markdown", "Employment Contract")
