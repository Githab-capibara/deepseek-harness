"""Standalone Fibonacci sequence helper."""


def beta(n: int) -> list[int]:
    """Return the first ``n`` Fibonacci numbers, starting with 0 and 1.

    Args:
        n: Number of Fibonacci numbers to produce.

    Returns:
        The first ``n`` Fibonacci numbers; an empty list when ``n`` is 0.

    Raises:
        TypeError: If ``n`` is not an ``int``; ``bool`` is rejected.
        ValueError: If ``n`` is negative.
    """
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"n must be an int, got {type(n).__name__}")
    if n < 0:
        raise ValueError(f"n must be non-negative, got {n}")

    numbers: list[int] = []
    current, following = 0, 1
    for _ in range(n):
        numbers.append(current)
        current, following = following, current + following
    return numbers
