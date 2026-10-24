const http = require('http');
const { EscrowService, mockDatabase } = require('./escrow'); 

const PORT = 3000;

const server = http.createServer(async (req, res) => {
    // Enable CORS for the frontend team
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    // 1. API Endpoint: Create Escrow Order
    if (parsedUrl.pathname === '/api/create-order' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                mockDatabase.orders[data.orderId] = {
                    id: data.orderId, itemPrice: data.amount, deliveryFee: 15000, 
                    dispatcherId: 'd_789', status: 'PENDING_PAYMENT', vendorId: data.vendorId, 
                    buyerId: data.buyerId, releaseCode: null
                };
                const result = await EscrowService.initiateEscrow(data.orderId, 'CLEVA');
                await EscrowService.handlePaymentWebhook(result.paymentIntent.transactionId, { status: 'SUCCESSFUL', orderId: data.orderId });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, releaseCodeForBuyer: result.releaseCode }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // 2. API Endpoint: Release Escrow
    if (parsedUrl.pathname === '/api/release-order' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { orderId, providedCode } = JSON.parse(body);
                const result = await EscrowService.dispatcherReleaseFunds(orderId, providedCode, 'CLEVA');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // Fallback for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
});

server.listen(PORT, () => console.log(`[Backend API] Running on port ${PORT}`));