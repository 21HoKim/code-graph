import argparse
import time

from pipeline import Runner, SensorSource


def build_sources(n: int):
    return [SensorSource(f"imu{i}", rate_hz=100.0) for i in range(n)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sensors", type=int, default=2)
    parser.add_argument("--seconds", type=float, default=2.0)
    args = parser.parse_args()
    runner = Runner(build_sources(args.sensors))
    runner.start()
    time.sleep(args.seconds)
    print(runner.stop())


if __name__ == "__main__":
    main()
