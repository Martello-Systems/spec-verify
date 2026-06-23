// Order schema definitions.
export const orderSchema = {
  type: 'object',
  properties: {
    items: { type: 'array' },
    // a per-order discount, and a discount code that maps to it
    discount: { type: 'number' },
    discountCode: { type: 'string' },
  },
  required: ['items'],
};
