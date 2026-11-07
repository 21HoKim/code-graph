Deliberately broken sample for CodeGraph's verification overlay:

- `report.py` has a syntax error → the whole module is red; `app.py` imports it → orange
- `metrics.summarize` calls `total`, which is defined nowhere → red (NameError when it runs)
- `CsvExporter` does not override `Exporter.write`, which raises NotImplementedError → red
