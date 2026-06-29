#  Multi-Agentic AI Medical Shop

A full-stack **AI-powered pharmacy management system** built with a multi-agent architecture. The system handles medicine ordering, prescription validation via OCR, inventory management, automated refill scheduling, and real-time SMS notifications — all orchestrated by specialized AI agents and an LLM-driven chat interface.

---

##  Features

-  **Multi-Agent Orchestration** — Dedicated agents for Orders, Inventory, and Payments, coordinated by a central `AgentOrchestrator`
-  **Prescription Validation** — OCR-powered prescription scanning using Tesseract.js with intelligent field extraction
-  **AI Chat Interface** — Conversational medicine ordering powered by OpenAI GPT
-  **Auto Refill Service** — LLM-driven automatic refill scheduling with configurable intervals
-  **Inventory Management** — Real-time stock checking with fuzzy medicine name matching
-  **SMS Notifications** — Order confirmations and refill alerts via Twilio
-  **Observability** — Full trace and span logging via Langfuse for agent activity monitoring
-  **NLP Service** — Natural language processing for medicine name recognition and intent detection

---

##  Architecture

```
┌─────────────────────────────────────────────┐
│                 Frontend (HTML/CSS)          │
│         public/index.html + styles.css       │
└──────────────────────┬──────────────────────┘
                       │ REST API
┌──────────────────────▼──────────────────────┐
│              Express Server (server.js)      │
│  ┌──────────┐  ┌────────────┐  ┌─────────┐  │
│  │NLP Svc   │  │LLM Service │  │Auto     │  │
│  │          │  │(OpenAI)    │  │Refill   │  │
│  └──────────┘  └────────────┘  └─────────┘  │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│           Agent Orchestrator (agents/)       │
│  ┌────────────┐ ┌───────────┐ ┌──────────┐  │
│  │OrderAgent  │ │Inventory  │ │Payment   │  │
│  │            │ │Agent      │ │Agent     │  │
│  └────────────┘ └───────────┘ └──────────┘  │
└──────────────────────┬──────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │          MySQL Database      │
        │    + Langfuse Observability  │
        └─────────────────────────────┘
```

---

##  Project Structure

```
Multi-Agentic-AI-Medical-Shop/
│
├── agents/
│   ├── index.js               # AgentOrchestrator — coordinates all agents
│   ├── orderAgent.js          # Validates and processes medicine orders
│   ├── inventoryAgent.js      # Checks stock availability
│   └── paymentAgent.js        # Handles payment processing
│
├── config/
│   ├── database.js            # MySQL connection pool setup
│   └── observability.js       # Langfuse trace/span configuration
│
├── services/
│   ├── llmService.js          # OpenAI GPT integration for chat & medicine matching
│   ├── nlpService.js          # NLP for intent detection and entity extraction
│   └── autoRefillService.js   # Automated prescription refill scheduling
│
├── public/
│   ├── index.html             # Frontend UI
│   ├── styles.css             # Styles
│   └── avatar-video.mp4       # Avatar animation asset
│
├── server.js                  # Express app entry point, API routes
├── prescriptionValidator.js   # OCR-based prescription field extractor
├── index.js                   # Alternate orchestrator (with PrescriptionAgent)
├── test-refill.js             # Test script for the auto-refill service
├── eng.traineddata            # Tesseract OCR language model (English)
├── package.json
└── .env                       # Environment variables (see setup below)
```

---

##  Prerequisites

- [Node.js](https://nodejs.org/) v18+
- MySQL database (local or hosted, e.g. [FreeSQLDatabase](https://www.freesqldatabase.com/))
- [OpenAI API Key](https://platform.openai.com/)
- [Twilio Account](https://www.twilio.com/) (for SMS — optional)
- [Langfuse Account](https://langfuse.com/) (for observability — optional)

---

##  Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/Multi-Agentic-AI-Medical-Shop.git
   cd Multi-Agentic-AI-Medical-Shop
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the root directory (see `.env.example` below):

   ```env
   # Database
   DB_HOST=your_db_host
   DB_NAME=your_db_name
   DB_USER=your_db_user
   DB_PASSWORD=your_db_password
   DB_PORT=3306

   # OpenAI
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_CHAT_MODEL=gpt-3.5-turbo
   OPENAI_MED_MATCH_MODEL=gpt-4o-mini

   # Twilio (optional)
   TWILIO_ACCOUNT_SID=your_account_sid
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

   # Langfuse (optional)
   LANGFUSE_PUBLIC_KEY=your_public_key
   LANGFUSE_SECRET_KEY=your_secret_key
   LANGFUSE_HOST=https://cloud.langfuse.com

   # Auto Refill
   ENABLE_AUTO_REFILL=true
   REFILL_CHECK_INTERVAL=24

   # Server
   PORT=3000
   APP_URL=http://localhost:3000
   ```

   >  **Never commit your `.env` file.** Add it to `.gitignore`.

4. **Set up the database**

   Create the required tables in your MySQL database. The system expects tables for medicines, orders, patients, and prescriptions. Refer to `config/database.js` for the schema structure.

5. **Start the server**
   ```bash
   # Production
   npm start

   # Development (with auto-reload)
   npm run dev
   ```

6. **Open the app**

   Visit `http://localhost:3000` in your browser.

---

##  Key API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/order` | Place a medicine order via the agent pipeline |
| `POST` | `/api/prescription/validate` | Upload and validate a prescription image |
| `POST` | `/api/chat` | Chat with the AI assistant |
| `GET`  | `/api/inventory` | Get current inventory status |
| `POST` | `/api/refill/schedule` | Schedule an automatic refill |

---

##  Agent Flow

When an order is placed, the `AgentOrchestrator` coordinates the following chain:

1. **OrderAgent** — Validates the order data, checks for required fields
2. **InventoryAgent** — Verifies stock availability using fuzzy name matching
3. **PaymentAgent** — Processes the payment and confirms the transaction
4. **PrescriptionAgent** *(if applicable)* — Validates prescription requirements for restricted medicines

Each step is traced via Langfuse for full observability.

---

##  Prescription Validation

Prescriptions are validated using **Tesseract.js OCR** (`eng.traineddata`). The `PrescriptionValidator` extracts:
- Patient name
- Doctor name & registration number
- Prescribed medicines and dosage
- Date of prescription

---

##  Testing Auto Refill

```bash
node test-refill.js
```

This script simulates the auto-refill service logic without needing a running server.

---

##  Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Web server & API routing |
| `openai` | GPT-based chat and medicine matching |
| `tesseract.js` | OCR for prescription scanning |
| `mysql2` | MySQL database connectivity |
| `twilio` | SMS notifications |
| `langfuse` | Agent observability & tracing |
| `natural` | NLP tokenization & stemming |
| `compromise` | NLP entity recognition |
| `fuzzball` | Fuzzy medicine name matching |
| `multer` | File upload handling |
| `dotenv` | Environment variable management |

---

##  Security Notes

- Remove the `.env` file from version control and rotate any credentials that were exposed
- Add `.env` to your `.gitignore` before committing:
  ```
  .env
  node_modules/
  uploads/
  ```
- Consider using environment variable management tools (AWS Secrets Manager, Doppler, etc.) for production deployments

---

##  Roadmap

- [ ] Add role-based authentication (admin vs patient)
- [ ] Build a dedicated admin dashboard for inventory management
- [ ] Add support for multiple pharmacy branches
- [ ] Integrate payment gateway (Stripe / Razorpay)
- [ ] Add Docker support for easy deployment
- [ ] Expand OCR to support Hindi/regional language prescriptions

---

##  Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request

---

##  License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

##  Author

Built with ❤️ as a multi-agentic AI system for modern pharmacy automation.
