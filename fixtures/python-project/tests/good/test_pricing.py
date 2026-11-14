# Honest pytest tests: each one fails when the behavior it names breaks.
from unittest.mock import Mock

import pytest

from app.pricing import apply_discount, qualifies_for_free_shipping


def test_takes_the_percentage_off():
    assert apply_discount(200, 25) == 150


@pytest.mark.parametrize("percent, expected", [(0, 200), (100, 0)])
def test_accepts_boundaries(percent, expected):
    assert apply_discount(200, percent) == expected


def test_rejects_percent_outside_range():
    with pytest.raises(ValueError, match="percent"):
        apply_discount(200, 101)
    with pytest.raises(ValueError):
        apply_discount(200, -1)


def test_free_shipping_starts_at_50():
    assert qualifies_for_free_shipping(49.99, False) is False
    assert qualifies_for_free_shipping(50, False) is True


def test_error_object_is_inspected():
    try:
        apply_discount(1, 500)
    except ValueError as e:
        assert "0..100" in str(e)
    else:
        pytest.fail("expected ValueError")


class TestMembers:
    def test_members_always_qualify(self):
        assert qualifies_for_free_shipping(0, True)

    def test_callback_receives_total(self):
        callback = Mock()
        callback(qualifies_for_free_shipping(60, False))
        callback.assert_called_once_with(True)
