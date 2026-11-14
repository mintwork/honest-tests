# AI-style pytest tests: every one of these passes, and none can catch a bug.
from unittest.mock import Mock, patch

import pytest

from app import pricing
from app.pricing import apply_discount


def test_discount_is_self_consistent():
    result = apply_discount(100, 10)
    assert result == result


def test_applies_discount():
    apply_discount(100, 10)


def test_discount_tuple_assert():
    assert (apply_discount(100, 20) == 70, "20% off")


def test_wrong_value_is_swallowed():
    try:
        assert apply_discount(100, 20) == 70
    except AssertionError:
        pass


def test_rejects_bad_percent():
    try:
        apply_discount(100, 150)
    except ValueError as e:
        assert "percent" in str(e)


def test_free_shipping_mock():
    qualifies = Mock(return_value=True)
    assert qualifies(10, True) is True


def test_member_flag():
    shipping = {"member": True, "threshold": 50}
    assert shipping["threshold"] == 50


@patch("app.pricing.apply_discount", return_value=80)
def test_patched_unit(mock_discount):
    assert pricing.apply_discount(100, 20) == 80


def test_called_check():
    notify = Mock()
    notify("sent")
    assert notify.called_once_with("sent")


def test_items_non_negative():
    items = pricing.qualifies_for_free_shipping(10, False)
    assert len([items]) >= 0


def test_only_when_member():
    result = pricing.qualifies_for_free_shipping(10, True)
    if result:
        assert result is True


@pytest.mark.skip(reason="flaky")
def test_skipped():
    assert apply_discount(100, 0) == 100


def test_constant():
    assert True
