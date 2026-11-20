"""Primality checking helpers."""


def gamma(n: int) -> bool:
    """Return True when ``n`` is a prime number.

    Args:
        n: Integer to test for primality.

    Returns:
        True if ``n`` is prime, False otherwise.

    Raises:
        TypeError: If ``n`` is not an ``int`` (``bool`` is rejected).
    """
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"n must be an int, got {type(n).__name__}")

    if n < 2:
        return False
    if n % 2 == 0:
        return n == 2

    divisor = 3
    while divisor * divisor <= n:
        if n % divisor == 0:
            return False
        divisor += 2

    return True
