import { z } from "zod";
import { db } from "./db";

export const orderStatusSchema = z.enum([
  "pending", "confirmed", "packed", "shipped", "delivered", "cancelled",
]);

export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Same shape as the documents inserted by scripts/seed-orders.ts
export const orderSchema = z.object({
  orderId: z.string(),
  orgId: z.string(),
  customerName: z.string(),
  customerEmail: z.string(),
  items: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number() })),
  status: orderStatusSchema,
  shippingDate: z.date(),
  rescheduleCount: z.number(),
  createdAt: z.date(),
});

export type Order = z.infer<typeof orderSchema>

const ordersCollection = () => db.collection<Order>("orders");

/** "2026-11-06" -> [start of that day, start of the next day[, to match a stored Date on that day */
function dayRange(isoDate: string): { $gte: Date; $lt: Date } {
  const start = new Date(`${isoDate}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { $gte: start, $lt: end };
}

export const getOrder = async ({ orderId, shippingDate, customerEmail, orgId }: {
  orderId?: string,
  shippingDate?: string,
  customerEmail?: string,
  orgId: string
}) => {

  if (!orgId) {
    throw new Error("Missing organization id in getOrder")
  }

  // Either the order number, or the email AND the shipping date together
  if (!orderId && !(shippingDate && customerEmail)) {
    throw new Error("Missing parameters in getOrder")
  }

  const query: Record<string, unknown> = { orgId }
  if (orderId) {
    query.orderId = orderId
  }
  else {
    query.customerEmail = customerEmail!.trim().toLowerCase()
    query.shippingDate = dayRange(shippingDate!)
  }

  console.log("QUERY", query)

  const order = await ordersCollection().findOne(query)

  return order
}

export const updateOrderDeliveryDate = async ({ orgId, orderId, requestedDate }: { orgId: string, orderId: string, requestedDate: string }) => {
  if (!orgId || !orderId || !requestedDate) {
    throw new Error("Missing parameters in updateOrderDeliveryDate")
  }

  const result = await ordersCollection().updateOne(
    { orgId, orderId },
    {
      $set: { shippingDate: new Date(`${requestedDate}T12:00:00`) }, // stored as a Date, like in the seed
      $inc: { rescheduleCount: 1 },
    },
  )

  if (result.matchedCount === 0) {
    throw new Error(`Order ${orderId} not found for organization ${orgId}`)
  }

  return result;
}