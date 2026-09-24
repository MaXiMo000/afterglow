"""Worker entry point. A0 stub: exits so the image can be built, scanned and wired up before A1."""

import sys


def main() -> int:
    sys.stderr.write("afterglow worker: not implemented until milestone A1\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
