\# Optical Shop Management System 👓



A comprehensive, production-grade management system designed to streamline day-to-day operations for optical retail outlets. This system optimizes inventory tracking, customer prescription history, sales workflows, and automated reporting.



\## 🚀 Key Features



\* \*\*Prescription \& Patient History Management\*\*: Digitally record and track sphere (SPH), cylinder (CYL), axis, and near-vision addition (ADD) values for both left (OS) and right (OD) eyes.

\* \*\*Smart Inventory Tracking\*\*: Real-time stock level management for frames, lenses, contact lenses, and accessories with low-stock alerts.

\* \*\*Sales \& Billing Terminal\*\*: Seamless point-of-sale (POS) workflows generating instant, detailed digital receipts.

\* \*\*Database \& Backups\*\*: Automated data backup routines to prevent data loss and ensure long-term operational resilience.

\* \*\*Analytics Dashboard\*\*: Quick visual metrics on daily sales, top-performing frame designs, and upcoming prescription check-ups.



\---



\## 🛠️ Tech Stack



\* \*\*Frontend\*\*: HTML5, CSS3, JavaScript (Modern UI/UX designed for fast-paced retail environments)

\* \*\*Backend\*\*: Node.js \& Express (RESTful API architecture handling business logic and routing)

\* \*\*Database\*\*: Local JSON-based relational simulation / SQLite (Optimized for quick local deployments)



\---



\## 📁 Project Structure



```text

├── db/                  # Local database schemas and JSON datastores

├── public/              # Frontend assets, stylesheets, and client-side scripts

├── server/              # Backend application core

│   ├── routes/          # Express route handlers (auth, inventory, prescriptions, sales)

│   ├── middleware/      # Authentication and request validation layers

│   └── server.js        # Main application entry point

├── .gitignore           # Excludes local dependency directories (node\_modules)

├── package.json         # Project metadata and dependency configuration

└── README.md            # Project documentation



