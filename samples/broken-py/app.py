from exporters import CsvExporter
from metrics import collect, summarize
from report import render


def main():
    rows = collect()
    stats = summarize(rows)
    CsvExporter().write(rows)
    print(render(stats))


if __name__ == "__main__":
    main()
