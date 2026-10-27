# PaySplit

PaySplit splits customer revenue among employees. It replaces the
**Employee Contribution & Pay-Split** Excel workbook with a web app.

- **Frontend:** React 18 + Vite (`client/`)
- **Backend:** Node.js HTTP server with no npm dependencies (`server/`)
- **Database:** SQLite through Node's built-in `node:sqlite` module, saved in `data/paysplit.db`

## How the calculation works

It works the same way as the workbook:

1. Each **customer** has a **currency** (INR, USD, EUR, GBP, AUD, SGD or AED), an onboard month, a payment frequency and a revenue split
   between **Direct**, **Support** and **Others**, which must add up to 100% (for example 70 / 20 / 10).
2. Each revenue share is filled in top to bottom: (1) the **payment date**, when billing starts (the
   onboard month is not the billing date; it can't be before it); (2) **billing From** (= the payment
   date) and **To**, 12 months on by default (36 for Three Years): Monthly bills every month,
   Yearly once a year from the payment date, and Three Years once, for Year 1, unless its share is set to pay **every year** (Year 1, 2, 3); (3) the **payment type**, One time or Custom
   with **Payout From/To** (for the first payment; later payments move along); (4) Direct / Support / Others.
3. In each period you enter the **revenue** in the customer's currency and the **share for employees**
   (10% by default), and add **contributors** to each category, each with a **weightage %**.
4. **Pool = Revenue × Share %**, and **Pay = Pool × Category % × Weightage %.** Pay is always calculated
   and never typed in. Pay is in the customer's currency; for a customer not in INR, **Convert to INR**
   on a payment takes a rate (today's European Central Bank rate is offered) and pays that payment in INR.
   Pay in different currencies is never added together: Summary shows one currency at a time, and
   All payments and Employees show a total per currency.
5. Each payment has a **payment date** (the month it's paid, which can differ from the onboard month).
   **Monthly** customers have a payment every month, each with its own amount and weightages. For
   **Yearly** and **Three Years**, the **payment type** is **One time** (one amount, one set of
   weightages) or **Custom**: the amount is entered once and split equally over the payout months
   (From to To), and **each month has its own contributors and weightages** (chosen with month tabs on
   the payment page). Each month is marked paid on its own once it has arrived. A revenue share's
   payment type is the default for its payments.
   The payment page is a 3-step wizard: **1 Weightages**, **2 Ratings & comments** (one employee at a
   time: a rating from 1 Exceptional, 2 Exceeds expectation, 3 Meets expectation, 4 Needs Improvement
   to 5 Unsatisfactory, and a comment with specific instances; "Copy from" reuses last month's), and
   **3 Review & save**. Each employee is rated on each customer's payment, for each month of it.
   Ratings are optional when saving, but every employee must be rated before their pay can be
   submitted in a quarterly payout. Only admins (including the owner) rate.
6. **Payouts** (admins): pay is paid every quarter. Pay for a month belongs to its calendar quarter
   (Oct to Dec, Jan to Mar, ...) and is paid in the pay month, 1 month after the quarter by default
   (so Oct to Dec is paid in January). For a quarter, an admin writes a **comment for each employee**
   and submits it (the amounts are frozen and that pay is locked on the payment pages); a **different
   admin approves** each employee's line, or all at once (the page lists the admins, and each waiting line shows who can approve it). **Approvals needed** on the Payouts page sets how many: 0 (lines are approved when submitted), 1 (default) or 2 different admins, never the one who submitted; lowering it approves waiting lines that already have enough. Then the
   approved lines are marked paid with the payroll date. Until paid, an approval can be undone (the line
   waits for approval again) and a submission undone (its pay is back in To submit), each with a comment; a line marked paid by mistake can be set back to approved with Undo paid (one line, or all paid lines in the quarter), also with a comment;
   the quarter's **History** shows every step, who did it and the comment, and opening a line shows its own submission and approval history. Pay added later for a quarter that's already
   paid goes into the next quarter. Employees see their own statements and comments on My pay, and
   their ratings and rating comments once the line is approved. Opening an employee on the Payouts page
   shows each customer with the weightage, amount, rating and comment; submitting freezes the ratings.
   Quarterly payouts start with Q4 2026; pay marked paid before that stays as it was.
7. **Summary** shows each employee's pay per month and per year (in the payment date month, or in each
   part's month for Custom). **All payments** is the
   full log, and you can download it as a CSV file.

A yearly customer's pay is counted in the month its year starts, just like the workbook's Monthly Summary.

## Requirements

Node.js **22.13 or newer**. Check with `node --version`.

## First-time setup

```bash
npm run install:client     # installs React + Vite inside client/
npm run seed               # optional: loads the employees and customers from the Excel workbook
```

## Run it

**Simple (one terminal):**
```bash
npm run build
npm start
```
Open http://localhost:3000. Run `npm run build` again after you change anything in `client/`.

**Development (two terminals, updates as soon as you save a file):**
```bash
npm run dev:server     # terminal 1: API on :3000
npm run dev:client     # terminal 2: React on :5173
```
Open http://localhost:5173.

## Screens

| Screen        | What it does                                                                 |
|---------------|------------------------------------------------------------------------------|
| Summary       | Pay by month and by year for every employee, plus revenue that isn't assigned |
| Customers     | Add customers (Yearly or Monthly) and set the Direct / Support / Others split |
| Customer page | Pick a period, enter revenue, add contributors and weightages, then save     |
| Employees     | Add, rename, and mark employees active or inactive                          |
| All payments  | Every payment row, with filters and a CSV download                         |
| Deployments   | Everyone: what's deployed at each customer (product, service versions, features, environment) |
| Users         | Admins only: add people as Admin or Employee, send setup links, remove access |
| Azure DevOps  | Admins only: organisation, project, area paths and their sprints           |

Click an employee's name to see their Azure DevOps tasks in each configured area path and sprint,
grouped under the parent User Story (matched by the employee's email).
Each customer's page ends with **Team progress**: the customer's Azure DevOps Tasks and Bugs (matched
by the Client field, or the "Client name in Azure DevOps" set under Edit customer), totalled per
employee for all months, a year, or a From–To range of months, ranked by most closed.

**Deployments** records what's installed at each customer: the product (e.g. Hybr), the services
deployed with a version for each (Hybr, vConnect, Billing, CC), the date, the environment and notes,
plus who entered it and when. Anyone signed in can add one and change or delete their own; admins
can change any and edit the lists of choices (**Edit lists**). **Features enabled** (Billing CSP,
Billing vConnect, vCenter, SPF, Service Catalog) belong to the customer, not to a deployment: tick
them on the customer's deployments page (or on Deployments with that customer chosen). Anyone can
add a new feature to the list. Employees see only customer names there. Each
customer has its own deployments page (the **Deployments** button on the customer page, or the
**Deployed** column in the Customers table) with the latest deployment per product and environment
and the full history.

## Azure DevOps

Set the **`AZ_PAT`** environment variable (on Azure: App Service > Configuration > Application
settings) to a personal access token with **Work Items (Read)** access. It's never stored in the
database or sent to the browser. Then, on the Azure DevOps page, enter the organisation and project,
add area paths, and add sprints (iteration paths) under each one; each is checked with Azure DevOps
and a sprint's name and dates are copied from there.

## Users and logins

There is no public sign-up. The **owner** (the first account, or `OWNER_EMAIL` if set) has full
access and can't be deleted or changed. Owner is not a role you can give to others.

1. An admin adds a person on the **Users** page with a name, email and role.
2. PaySplit shows a one-time **setup link** (valid 7 days). The admin sends it to them.
3. They open the link, choose a password, and are logged in. After that they log in normally.

**Reset password** on the Users page makes a new link; the old password keeps working until it is used.
If the database has no users at all, the login page shows a one-time form to create the owner.

- **Owner:** everything, including the Users page. Only one, set automatically.
- **Admin:** everything, including the Users and Azure DevOps pages.
- **Employee:** only their own data on the Summary, Employees and All payments pages, plus their own
  Azure DevOps tasks. No Customers, Users or Azure DevOps pages. A login is linked to an employee by
  email, so the login's email must match the employee's email on the Employees page.

Helpful tools on the customer page:
- **Split equally** gives every contributor in a category the same weightage.
- **Copy contributors from last month** reuses the previous month's split.
- **Mark paid** (with the date paid) on each contributor, or **Mark all as paid**. A paid row keeps the amount paid and
  its weightage can't change; while anyone in a payment is paid, its revenue is locked. **Undo** removes the mark.
- A bar under each category shows how much of its pool is assigned. Totals over 100% can't be saved.

## Project structure

```
server/
  index.js          HTTP server, auth check, serves the React build
  http.js           Router and HTTP helpers
  db.js             SQLite tables and the "payments" view (the pay formula)
  auth.js           Password hashing (scrypt) and sessions
  seed.js           Sample data from the Excel workbook
  routes/auth.js    Log in, log out, first-time setup, setup links
  routes/users.js   Users page API (admins only)
  routes/data.js    Employees, customers, periods, payments, summary
  routes/azdo.js    Azure DevOps settings and each employee's sprint tasks
  routes/deployments.js  Deployments per customer and the lists of choices
client/src/
  App.jsx           Login or the app
  components/       Top bar and navigation, shared bits
  pages/            Login, Setup, SetPassword, Users, Summary, Customers,
                    CustomerDetail, PeriodEditor, Employees, Payments
```

## Database tables

```
users                    id, name, email, role (admin/employee), is_owner, last_login_at, setup link
sessions                 login sessions
employees                id, employee_code, name, email, active, type
customers                id, name, onboard_month, frequency, currency, azdo_client
shares                   id, customer_id, name, from_month, to_month, payment_month, direct_pct, support_pct, others_pct, payout_type,
                         pay_from, pay_to (custom payout months for the first payment)
periods                  id, customer_id, start_month, amount (customer currency), share_pct, fx_rate (to INR, or NULL),
                         revenue (employees' pool = amount × share_pct × fx_rate, in the pay currency)
                         pay_month (payment date), payout_type (once / custom), pay_from, pay_to
part_paid                allocation_id, seq, month, paid_on, paid_amount, paid_by (paid marks on custom payments' months)
allocations              id, period_id, part (month of a custom payment, or NULL), category, employee_id, weightage, paid_on, paid_amount, paid_by
payments (view)          every allocation with pay = revenue × category % × weightage, and the amount paid
payout_settings          key, value (pay_lag, first_quarter)
payout_runs              id, quarter
payout_lines             run, employee, currency, amount, comment, status (submitted/approved/paid), who/when, approver_comment, paid_on
payout_items             line, allocation, part (month), part_month, amount, rating, rating_comment (frozen)
payout_notes             quarter, employee, comment before submitting, sent_back_reason (undo-submit comment)
ratings                  period, part (0 = whole payment, else the month), employee, rating (1-5), comment, rated_by, rated_at
payout_log               quarter, employee, currency, amount, action (submitted/approved/undo_approve/undo_submit/paid), comment, by, at
azdo_settings            key, value (Azure DevOps organisation and project)
azdo_areas               id, path, name, display_name
azdo_iterations          id, area_id, path, name, start_date, finish_date
deployments              id, customer_id, product, environment, deployed_on, services (JSON: name, version),
                         notes, created_by, created_at, updated_by, updated_at
deployment_options       id, kind (product/service/feature/environment), name
customer_features        customer_id, name, added_by, added_at (features enabled for a customer)
```

Percentages are stored as fractions (0.7 = 70%).

## API (login required except for /api/auth/*)

| Method | Path                          | Purpose                                         |
|--------|-------------------------------|-------------------------------------------------|
| GET    | /api/employees                | List employees with total pay                   |
| POST   | /api/employees                | Add `{ employee_code, name, email, type }`       |
| PATCH  | /api/employees/:id            | Rename or change active status                  |
| DELETE | /api/employees/:id            | Delete (only if the employee is in no split)    |
| GET    | /api/customers                | List customers with revenue and amount paid out |
| POST   | /api/customers                | Add a customer and create its periods           |
| GET    | /api/customers/:id            | Customer with periods, contributors and pay     |
| PATCH  | /api/customers/:id            | Change name or split                            |
| DELETE | /api/customers/:id            | Delete a customer and its periods               |
| POST   | /api/customers/:id/periods    | Add the next month or year                      |
| PUT    | /api/periods/:id              | Save revenue and contributors for a period      |
| POST   | /api/allocations/:id/paid     | Mark one contributor paid `{ paid_on }`          |
| DELETE | /api/allocations/:id/paid     | Undo a paid mark                                |
| POST   | /api/allocations/:id/parts/:seq/paid | Mark one month of a custom payment paid `{ paid_on }` |
| DELETE | /api/allocations/:id/parts/:seq/paid | Undo a month's paid mark                 |
| POST   | /api/periods/:id/paid         | Mark everyone unpaid in a period paid           |
| DELETE | /api/periods/:id              | Delete a period                                 |
| GET    | /api/payments                 | All payment rows                                |
| GET    | /api/deployments              | Deployments, customer names and the lists of choices |
| POST   | /api/deployments              | Add `{ customer_id, product, environment, deployed_on, services: [{name, version}], notes }` |
| PATCH  | /api/deployments/:id          | Change a deployment (the person who added it, or an admin) |
| DELETE | /api/deployments/:id          | Delete a deployment (the person who added it, or an admin) |
| PUT    | /api/customers/:id/features   | Set a customer's features enabled `{ features: [names] }` |
| POST   | /api/deployment-options       | Add a choice `{ kind, name }` (features: anyone; other lists: admin) |
| DELETE | /api/deployment-options/:id   | Admin: remove a choice                          |
| GET    | /api/summary?currency=USD     | Pay by month and by year, in one currency (INR by default) |
| GET    | /api/exchange-rate?from=USD   | Today's rate from a currency to INR             |
| GET    | /api/users                    | Admin: list users with status and last login    |
| POST   | /api/users                    | Admin: add `{ name, email, role }`, returns a setup link |
| PATCH  | /api/users/:id                | Admin: rename or change role                    |
| DELETE | /api/users/:id                | Admin: delete anyone except the owner           |
| POST   | /api/users/:id/invite         | Admin: new setup or password reset link         |
| POST   | /api/users/:id/logout         | Admin: sign a user out everywhere               |
