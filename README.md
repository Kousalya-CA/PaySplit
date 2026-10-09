# PaySplit

PaySplit splits customer revenue among employees. It replaces the
**Employee Contribution & Pay-Split** Excel workbook with a web app.

- **Frontend:** React 18 + Vite (`client/`)
- **Backend:** Node.js HTTP server with no npm dependencies (`server/`)
- **Database:** SQLite through Node's built-in `node:sqlite` module, saved in `data/paysplit.db`

## How the calculation works

It works the same way as the workbook:

1. Each **customer** has an onboard month, a payment frequency and a revenue split
   between **Direct**, **Support** and **Others**, which must add up to 100% (for example 70 / 20 / 10).
2. A **Yearly** customer gets one period, and its split holds for 12 months. A **Monthly**
   customer gets 12 monthly periods, and the split can change every month.
3. In each period you enter the **revenue** and add **contributors** to each category,
   each with a **weightage %**.
4. **Pay = Revenue × Category % × Weightage %.** Pay is always calculated and never typed in.
5. **Summary** shows each employee's pay per month and per year. **All payments** is the
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
| Users         | Admins only: add people as Admin or Employee, send setup links, remove access |
| Azure DevOps  | Admins only: organisation, project, area paths and their sprints           |

Click an employee's name to see their Azure DevOps tasks in each configured area path and sprint,
grouped under the parent User Story (matched by the employee's email).
Each customer's page ends with **Team progress**: the customer's Azure DevOps Tasks and Bugs (matched
by the Client field, or the "Client name in Azure DevOps" set under Edit customer), totalled per
employee for all months, a year, or a From–To range of months, ranked by most closed.

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
customers                id, name, onboard_month, frequency, azdo_client
shares                   id, customer_id, name, from_month, to_month, payment_month, direct_pct, support_pct, others_pct
periods                  id, customer_id, start_month, revenue, total_usd, usd_pct, usd_inr_rate
allocations              id, period_id, category, employee_id, weightage, paid_on, paid_amount, paid_by
payments (view)          every allocation with pay = revenue × category % × weightage, and the amount paid
azdo_settings            key, value (Azure DevOps organisation and project)
azdo_areas               id, path, name, display_name
azdo_iterations          id, area_id, path, name, start_date, finish_date
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
| POST   | /api/periods/:id/paid         | Mark everyone unpaid in a period paid           |
| DELETE | /api/periods/:id              | Delete a period                                 |
| GET    | /api/payments                 | All payment rows                                |
| GET    | /api/summary                  | Pay by month and by year                        |
| GET    | /api/users                    | Admin: list users with status and last login    |
| POST   | /api/users                    | Admin: add `{ name, email, role }`, returns a setup link |
| PATCH  | /api/users/:id                | Admin: rename or change role                    |
| DELETE | /api/users/:id                | Admin: delete anyone except the owner           |
| POST   | /api/users/:id/invite         | Admin: new setup or password reset link         |
| POST   | /api/users/:id/logout         | Admin: sign a user out everywhere               |
