export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) {
    throw new RangeError('percent must be between 0 and 100');
  }
  return amount - (amount * percent) / 100;
}

export function qualifiesForFreeShipping(total, isMember) {
  return isMember || total >= 50;
}
