from worker.__main__ import main


def test_worker_stub_exits_cleanly() -> None:
    assert main() == 0
