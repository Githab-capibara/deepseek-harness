"""Factorial helper for the ecosystem-check example set."""

__all__ = ["alpha"]


def alpha(n: int) -> int:
    """Return the factorial of ``n``.

    Args:
        n: Non-negative integer whose factorial is computed.

    Returns:
        ``n!``; ``alpha(0)`` is ``1``.

    Raises:
        TypeError: If ``n`` is not an integer (``bool`` is rejected).
        ValueError: If ``n`` is negative.
    """
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"alpha() expects an int, got {type(n).__name__}")
    if n < 0:
        raise ValueError(f"alpha() expects a non-negative int, got {n}")

    result = 1
    for factor in range(2, n + 1):
        result *= factor
    return result
