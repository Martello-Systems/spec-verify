// Order schema definitions.
export const orderSchema = {
  type: 'object',
  properties: {
    items: { type: 'array' },
    // a per-order discount, plus a discount code
    discount: { type: 'number' },
    discountCode: { type: 'string' },
  },
  required: ['items'],
};
