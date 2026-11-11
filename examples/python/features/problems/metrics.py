def raw_samples():
    return ["12", "15", "9", "21"]


def collect():
    return [int(x) for x in raw_samples()]


def summarize(rows):
    # BUG: `total` is defined nowhere, so this raises NameError when it runs
    return {"count": len(rows), "mean": total(rows) / len(rows)}
