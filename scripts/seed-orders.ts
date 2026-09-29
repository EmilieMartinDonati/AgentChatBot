
import { client, db } from "../lib/db";

type OrderStatus = "pending" | "confirmed" | "packed" | "shipped" | "delivered" | "cancelled";

type Order = {
    orderId: string;
    orgId: string;
    customerName: string;
    customerEmail: string;
    items: { sku: string; name: string; quantity: number }[];
    status: OrderStatus;
    shippingDate: Date;
    rescheduleCount: number;
    createdAt: Date;
};

function daysFromNow(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(12, 0, 0, 0);
    return d;
}

const orders: Order[] = [
    // ---------------- Acme Outdoor ----------------
    {
        orderId: "ACM-1001", orgId: "acme-outdoor", customerName: "Lucie Martin", customerEmail: "lucie.martin@example.com",
        items: [{ sku: "ACM-TNT-402", name: "Basecamp 4 Tent", quantity: 1 }],
        status: "confirmed", shippingDate: daysFromNow(3), rescheduleCount: 0, createdAt: daysFromNow(-2),
    },
    {
        orderId: "ACM-1002", orgId: "acme-outdoor", customerName: "Karim Benali", customerEmail: "karim.benali@example.com",
        items: [{ sku: "ACM-PAK-045", name: "Trailhead 45L Backpack", quantity: 1 }, { sku: "ACM-SHO-310", name: "Granite Mid GTX Boots", quantity: 1 }],
        status: "packed", shippingDate: daysFromNow(1), rescheduleCount: 0, createdAt: daysFromNow(-4),
    },
    {
        orderId: "ACM-1003", orgId: "acme-outdoor", customerName: "Sophie Durand", customerEmail: "sophie.durand@example.com",
        items: [{ sku: "ACM-BAG-015", name: "Nordwand -15 Sleeping Bag", quantity: 2 }],
        status: "shipped", shippingDate: daysFromNow(-1), rescheduleCount: 0, createdAt: daysFromNow(-6),
    },
    {
        orderId: "ACM-1004", orgId: "acme-outdoor", customerName: "Thomas Leroy", customerEmail: "thomas.leroy@example.com",
        items: [{ sku: "ACM-TNT-201", name: "Summit 2 Tent", quantity: 1 }],
        status: "pending", shippingDate: daysFromNow(5), rescheduleCount: 2, createdAt: daysFromNow(-1), // already rescheduled twice
    },

    // ---------------- Bloom & Co ----------------
    {
        orderId: "BLM-2001", orgId: "bloom-cosmetics", customerName: "Emma Petit", customerEmail: "emma.petit@example.com",
        items: [{ sku: "BLM-SER-01", name: "Glow Vitamin C Serum", quantity: 1 }],
        status: "pending", shippingDate: daysFromNow(1), rescheduleCount: 0, createdAt: daysFromNow(0),
    },
    {
        orderId: "BLM-2002", orgId: "bloom-cosmetics", customerName: "Chloé Bernard", customerEmail: "chloe.bernard@example.com",
        items: [{ sku: "BLM-CRM-02", name: "Cloud Night Cream", quantity: 1 }, { sku: "BLM-LIP-04", name: "Honey Lip Mask", quantity: 2 }],
        status: "confirmed", shippingDate: daysFromNow(1), rescheduleCount: 0, createdAt: daysFromNow(-1),
    },
    {
        orderId: "BLM-2003", orgId: "bloom-cosmetics", customerName: "Léa Moreau", customerEmail: "lea.moreau@example.com",
        items: [{ sku: "BLM-SPF-05", name: "Daily Shield SPF 50", quantity: 3 }],
        status: "delivered", shippingDate: daysFromNow(-5), rescheduleCount: 0, createdAt: daysFromNow(-8),
    },

    // ---------------- Fjord Home ----------------
    {
        orderId: "FJH-3001", orgId: "fjord-home", customerName: "Julien Roux", customerEmail: "julien.roux@example.com",
        items: [{ sku: "FJH-SOF-12", name: "Oslo 3-seat Sofa", quantity: 1 }],
        status: "confirmed", shippingDate: daysFromNow(10), rescheduleCount: 0, createdAt: daysFromNow(-7), // > 72h away: free change
    },
    {
        orderId: "FJH-3002", orgId: "fjord-home", customerName: "Camille Fournier", customerEmail: "camille.fournier@example.com",
        items: [{ sku: "FJH-BED-20", name: "Bergen Double Bed", quantity: 1 }, { sku: "FJH-WAR-07", name: "Tromso Wardrobe", quantity: 1 }],
        status: "confirmed", shippingDate: daysFromNow(2), rescheduleCount: 0, createdAt: daysFromNow(-12), // 24-72h away: €25 fee
    },
    {
        orderId: "FJH-3003", orgId: "fjord-home", customerName: "Antoine Girard", customerEmail: "antoine.girard@example.com",
        items: [{ sku: "FJH-TAB-03", name: "Aalborg Dining Table", quantity: 1 }],
        status: "shipped", shippingDate: daysFromNow(0), rescheduleCount: 0, createdAt: daysFromNow(-14), // too late to change
    },
];

async function main() {
    const collection = db.collection<Order>("orders");
    try {
        await collection.deleteMany({});

        await collection.insertMany(orders);
        // A normal (non-vector) index: getOrder will always query by orgId + orderId
        await collection.createIndex({ orgId: 1, orderId: 1 }, { unique: true });

        console.log(`\n✅ Inserted ${orders.length} orders.`);
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});