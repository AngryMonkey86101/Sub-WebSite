// Клиент API ЮKassa (https://yookassa.ru/developers): создать платёж, узнать его состояние,
// вернуть деньги.
//
// Платёж создаётся со списанием сразу (capture: true) и переходом на страницу оплаты ЮKassa
// (confirmation.type = redirect). После оплаты ЮKassa возвращает покупателя по return_url —
// в чат с ботом. Состояние платежа портал всегда узнаёт запросом GET /payments/{id}: телу
// HTTP-уведомления не верим, его мог прислать кто угодно.
//
// Idempotence-Key — из номера заказа: повтор запроса после обрыва связи не создаст второй платёж.
// Ни ключ магазина, ни адрес запроса в тексты ошибок не попадают.

const API = 'https://api.yookassa.ru/v3';

class YooKassaError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// settings — config.yookassa: { shopId, secretKey } или null
function createYooKassa({ settings, fetch = globalThis.fetch, api = API }) {
  if (!settings) return null;
  const auth = `Basic ${Buffer.from(`${settings.shopId}:${settings.secretKey}`).toString('base64')}`;

  async function call(method, path, { body = null, idempotenceKey = null } = {}) {
    let res;
    try {
      res = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: auth,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotenceKey ? { 'Idempotence-Key': idempotenceKey } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
    } catch (err) {
      throw new YooKassaError(`ЮKassa недоступна (${err.cause?.code ?? err.name})`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401) throw new YooKassaError('ЮKassa не приняла ключи магазина — проверьте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env', 401);
      throw new YooKassaError(`ЮKassa ответила ${res.status}${data?.description ? `: ${data.description}` : ''}`, res.status);
    }
    return data;
  }

  // amount — целые рубли. description попадает на страницу оплаты и в чек самозанятого (до 128 символов).
  async function createPayment({ orderId, amount, description, returnUrl }) {
    const payment = await call('POST', '/payments', {
      idempotenceKey: `family-vpn-order-${orderId}`,
      body: {
        amount: { value: `${amount}.00`, currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: description.slice(0, 128),
        metadata: { order_id: String(orderId) }
      }
    });
    const url = payment?.confirmation?.confirmation_url;
    if (!payment?.id || !url) throw new YooKassaError('ЮKassa не вернула ссылку на оплату');
    return { id: payment.id, status: payment.status, url };
  }

  // Состояние платежа: pending, waiting_for_capture, succeeded, canceled
  async function getPayment(id) {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(id)) throw new YooKassaError('Неверный номер платежа');
    const payment = await call('GET', `/payments/${id}`);
    return {
      id: payment.id,
      status: payment.status,
      paid: payment.paid === true,
      amount: payment.amount,
      orderId: payment.metadata?.order_id ?? null,
      cancelReason: payment.cancellation_details?.reason ?? null
    };
  }

  // Возврат части или всей суммы платежа. key — ключ идемпотентности: повтор после обрыва связи
  // не вернёт деньги дважды. Состояние: succeeded, pending (банк ещё обрабатывает) или canceled.
  async function createRefund({ paymentId, amount, description, key }) {
    const refund = await call('POST', '/refunds', {
      idempotenceKey: key,
      body: { payment_id: paymentId, amount: { value: `${amount}.00`, currency: 'RUB' }, description: description.slice(0, 250) }
    });
    if (!refund?.id) throw new YooKassaError('ЮKassa не вернула номер возврата');
    return { id: refund.id, status: refund.status, cancelReason: refund.cancellation_details?.reason ?? null };
  }

  return { createPayment, getPayment, createRefund };
}

export { createYooKassa, YooKassaError };
