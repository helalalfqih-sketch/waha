export class ShopPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopPolicyError';
  }
}

export function normalizeShopDomain(shop: string): string {
  return shop.trim().toLowerCase().replace(/\.$/, '');
}

export function assertAllowedShop(shop: string): string {
  const configuredShop = process.env.SHOPIFY_ALLOWED_SHOP;
  if (!configuredShop) {
    throw new ShopPolicyError('SHOPIFY_ALLOWED_SHOP is not configured');
  }

  const normalizedShop = normalizeShopDomain(shop);
  const normalizedAllowedShop = normalizeShopDomain(configuredShop);
  if (!normalizedShop || normalizedShop !== normalizedAllowedShop) {
    throw new ShopPolicyError('This Shopify store is not allowed');
  }

  return normalizedShop;
}
