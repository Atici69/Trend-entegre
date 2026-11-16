const integrations = [
  { id: 'trendyol', name: 'Trendyol', credentials: ['TRENDYOL_SUPPLIER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET'] },
  { id: 'hepsiburada', name: 'Hepsiburada', credentials: ['HEPSIBURADA_MERCHANT_ID', 'HEPSIBURADA_SECRET_KEY', 'HEPSIBURADA_USER_AGENT'] },
  { id: 'n11', name: 'n11', credentials: ['N11_API_KEY', 'N11_API_SECRET'] },
  { id: 'amazon', name: 'Amazon', credentials: ['AMAZON_SELLER_ID', 'AMAZON_CLIENT_ID', 'AMAZON_CLIENT_SECRET', 'AMAZON_REFRESH_TOKEN', 'AMAZON_MARKETPLACE_ID'] },
  { id: 'pazarama', name: 'Pazarama', credentials: ['PAZARAMA_API_KEY', 'PAZARAMA_API_SECRET'] },
  { id: 'ozon', name: 'Ozon', credentials: ['OZON_CLIENT_ID', 'OZON_API_KEY'] },
];

export function marketplaceStatus() {
  return integrations.map(({ id, name, credentials }) => {
    const configuredCount = credentials.filter((key) => Boolean(process.env[key]?.trim())).length;
    return {
      id,
      name,
      configured: configuredCount === credentials.length,
      configuredCredentials: configuredCount,
      requiredCredentials: credentials.length,
      connectionState: 'not_connected',
      note: 'Credentials alone do not verify an API connection. A marketplace-specific handshake is required.',
    };
  });
}
