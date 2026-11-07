class Exporter:
    def write(self, rows):
        raise NotImplementedError


class CsvExporter(Exporter):
    """Forgot to implement write(): calls fall through to the base-class stub."""

    def header(self):
        return "value"
