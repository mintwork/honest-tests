def apply_discount(amount, percent):
    if percent < 0 or percent > 100:
        raise ValueError("percent must be within 0..100")
    return amount * (100 - percent) / 100


def qualifies_for_free_shipping(total, is_member):
    return is_member or total >= 50
