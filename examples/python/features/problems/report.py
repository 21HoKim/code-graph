def render(stats):
    lines = [f"{k}: {v}" for k, v in stats.items()
    return "\n".join(lines)


def banner():
    return "== report =="
