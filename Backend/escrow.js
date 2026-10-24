const crypto = require('crypto');

// Stateful Mock Database for Testing
const mockState = {
    orders: {
        'ORDER_1': { 
            id: 'ORDER_1', 
            itemPrice: 850000,       // Cost of the actual product
            deliveryFee: 15000,      // Dispatcher's fare
            status: 'PENDING_PAYMENT', 
            vendorId: 'v_123', 
            buyerId: 'b_456', 
            dispatcherId: 'd_789',   // New: Assigned logistics partner
            releaseCode: null 
        }
    },
    wallets: {
        'b_456': 5000000,        // Buyer
        'v_123': 0,              // Vendor
        'd_789': 0,              // Dispatcher (New)
        'escrow_vault': 0        // Platform vault
    }
};

const db = {
    orders: {
        findById: async (id) => mockState.orders[id],
        updateStatus: async (id, status) => {
            if (mockState.orders[id]) mockState.orders[id].status = status;
            console.log(`[DB] Order ${id} status updated to ${status}`);
        },
        saveTransaction: async (data) => {
            if (mockState.orders[data.orderId]) {
                mockState.orders[data.orderId].releaseCode = data.releaseCode;
            }
            console.log(`[DB] Transaction saved for order: ${data.orderId}`);
        }
    },
    wallets: {
        transfer: async (from, to, amount) => {
            if (mockState.wallets[from] < amount) throw new Error(`Insufficient funds in ${from}`);
            mockState.wallets[from] -= amount;
            mockState.wallets[to] += amount;
            console.log(`[DB] Transferred ₦${amount.toLocaleString()} from ${from} to ${to}`);
        }
    }
};

class ClevaProvider {
    constructor(apiKey, apiSecret) {
        this.apiKey = apiKey;
        this.baseURL = "https://api.usecleva.com/v1"; 
    }

    async initializePayment(amount, currency, buyerId, orderId) {
        console.log(`[Cleva] Locking Total ${currency} ${amount} for Order ${orderId}`);
        await db.wallets.transfer(buyerId, 'escrow_vault', amount);
        return {
            success: true,
            transactionId: `clv_txn_${crypto.randomBytes(8).toString('hex')}`,
            paymentUrl: `https://checkout.usecleva.com/pay/${orderId}`
        };
    }

    async executeSplitPayout(vendorId, vendorAmount, dispatcherId, dispatcherAmount) {
        console.log(`[Cleva] Executing Split Payout from Vault...`);
        // 1. Pay the Vendor for the item
        await db.wallets.transfer('escrow_vault', vendorId, vendorAmount);
        // 2. Pay the Dispatcher for the delivery
        await db.wallets.transfer('escrow_vault', dispatcherId, dispatcherAmount);
        
        return { success: true, receipt: `clv_rec_${Date.now()}` };
    }
}

class EscrowService {
    constructor() {
        this.providers = { CLEVA: new ClevaProvider(process.env.CLEVA_API_KEY, process.env.CLEVA_SECRET) };
        this.platformFeePercentage = 0.015; 
    }

    async initiateEscrow(orderId, providerName = 'CLEVA') {
        const order = await db.orders.findById(orderId);
        if (!order) throw new Error("Order not found");

        const provider = this.providers[providerName];
        
        // Lock includes item price, delivery fee, and platform fee
        const subtotal = order.itemPrice + order.deliveryFee;
        const totalWithFee = subtotal + (subtotal * this.platformFeePercentage);
        
        const releaseCode = Math.floor(1000 + Math.random() * 9000).toString();

        const paymentIntent = await provider.initializePayment(totalWithFee, 'NGN', order.buyerId, order.id);

        await db.orders.saveTransaction({
            orderId,
            transactionId: paymentIntent.transactionId,
            releaseCode, 
            status: 'PENDING_PAYMENT'
        });

        return { paymentIntent, releaseCode };
    }

    async handlePaymentWebhook(transactionId, payload) {
        if (payload.status === 'SUCCESSFUL') {
            await db.orders.updateStatus(payload.orderId, 'FUNDS_LOCKED_IN_TRANSIT');
        }
    }

    // NEW: Dispatcher driven release function with split payouts
    async dispatcherReleaseFunds(orderId, dispatcherInputCode, providerName = 'CLEVA') {
        const order = await db.orders.findById(orderId); 
        
        if (order.status !== 'FUNDS_LOCKED_IN_TRANSIT') {
            throw new Error(`Escrow Breach: Order is in '${order.status}' state.`);
        }

        const storedCode = order.releaseCode;
        if (!storedCode || dispatcherInputCode !== storedCode) {
            throw new Error("Invalid Release Code. Cryptographic proof of delivery failed.");
        }

        const provider = this.providers[providerName];

        await db.orders.updateStatus(orderId, 'PROCESSING_SPLIT_RELEASE');

        try {
            // Trigger the split payout backend logic
            const payout = await provider.executeSplitPayout(
                order.vendorId, order.itemPrice, 
                order.dispatcherId, order.deliveryFee
            );
            
            if (payout.success) {
                await db.orders.updateStatus(orderId, 'DELIVERED_AND_CLEARED');
                return { message: "Funds split successfully to Vendor and Dispatcher" };
            } else {
                throw new Error("Split payout routing failed.");
            }
        } catch (error) {
            await db.orders.updateStatus(orderId, 'FUNDS_LOCKED_IN_TRANSIT');
            throw error;
        }
    }
}

const escrowInstance = new EscrowService();

// ==========================================
// TERMINAL TEST FOR DISPATCHER SPLIT PAYOUT
// ==========================================
async function runSecurityTests() {
    console.log("\n--- STARTING DISPATCHER ESCROW SIMULATION ---");
    console.log("Initial Balances:", mockState.wallets);

    try {
        console.log("\n>>> STEP 1: Buyer Checks Out (Item + Delivery + Fee)");
        const initResult = await escrowInstance.initiateEscrow('ORDER_1', 'CLEVA');
        const buyerCode = initResult.releaseCode;
        
        await escrowInstance.handlePaymentWebhook(initResult.paymentIntent.transactionId, {
            status: 'SUCCESSFUL', orderId: 'ORDER_1'
        });

        console.log("Balances after Buyer Lock:", mockState.wallets);

        console.log(`\n>>> STEP 2: Delivery Happens. Dispatcher inputs code: [${buyerCode}]`);
        await escrowInstance.dispatcherReleaseFunds('ORDER_1', buyerCode);
        
        console.log("\nFinal Balances After Split Payout:");
        console.table(mockState.wallets);
        console.log("--- SIMULATION COMPLETE ---");

    } catch (err) {
        console.error("Test framework error:", err);
    }
}

if (require.main === module) {
    runSecurityTests();
}

module.exports = { EscrowService: escrowInstance, mockDatabase: mockState };