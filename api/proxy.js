const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { parseString } = require('xml2js');

const app = express();
const cors = require('cors');
app.use(cors());

// Enable CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
app.use(bodyParser.text({ type: ['application/json', 'application/xml', 'text/xml'] }));

app.post('/', async (req, res) => {
    try {
        const contentType = req.headers['content-type'] || '';
        let input;

        // Parse input based on content type
        if (contentType.includes('application/json')) {
            try {
                input = JSON.parse(req.body);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON input" });
            }
        } else if (contentType.includes('application/xml') || contentType.includes('text/xml')) {
            try {
                const result = await parseXml(req.body);
                input = result;
            } catch (e) {
                return res.status(400).json({ error: "Invalid XML input" });
            }
        } else {
            return res.status(415).json({ error: "Unsupported Content-Type" });
        }

        if (!input || !input.api) {
            return res.status(400).json({ error: "Invalid input format" });
        }

        if (!input.api.url || !input.api.method) {
            return res.status(400).json({ error: "Missing required fields: 'url' or 'method'" });
        }

        const { url, method, header = [], body: postData } = input.api;
        const requestMethod = method.toUpperCase();

        // Prepare axios config
        const config = {
            method: requestMethod,
            url: url,
            headers: {},
            // Don't verify SSL certificate (equivalent to CURLOPT_SSL_VERIFYPEER = false)
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        };

        // Add headers if provided
        if (Array.isArray(header)) {
            header.forEach(h => {
                if (h.includes(':')) {
                    const [key, ...value] = h.split(':');
                    config.headers[key.trim()] = value.join(':').trim();
                }
            });
        }

        // Handle request data
        if (postData !== undefined && postData !== null && requestMethod !== 'GET') {
            if (typeof postData === 'string') {
                try {
                    // Try to parse as JSON if it's a string
                    config.data = JSON.parse(postData);
                } catch (e) {
                    // If not JSON, send as-is
                    config.data = postData;
                }
            } else {
                config.data = postData;
            }
        }

        // Make the request
        const response = await axios(config);

        // Forward the response with appropriate content type
        const responseContentType = response.headers['content-type'] || '';
        if (responseContentType.includes('application/json')) {
            res.set('Content-Type', 'application/json');
            res.send(response.data);
        } else if (responseContentType.includes('application/xml') || responseContentType.includes('text/xml')) {
            res.set('Content-Type', 'application/xml');
            res.send(response.data);
        } else {
            res.set('Content-Type', 'text/plain');
            res.send(response.data);
        }

    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            res.status(error.response.status)
               .set(error.response.headers)
               .send(error.response.data);
        } else if (error.request) {
            // The request was made but no response was received
            res.status(500).json({ error: "No response received from target server" });
        } else {
            // Something happened in setting up the request
            res.status(500).json({ error: error.message });
        }
    }
});

// Helper function to parse XML
function parseXml(xml) {
    return new Promise((resolve, reject) => {
        parseString(xml, { explicitArray: false, ignoreAttrs: true }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});