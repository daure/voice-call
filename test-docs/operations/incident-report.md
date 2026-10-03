# Incident Report: Reservation Confirmation Delay

This is a fictional incident at Harbor Books.

Incident identifier: HB-042.
Severity: moderate service interruption.
Date: 2026-09-18.
Coordinator: Priya Shah.

## Timeline

- 14:05 UTC: a reminder-job release starts.
- 14:12 UTC: staff report reservation confirmations waiting in the queue.
- 14:18 UTC: the queue reaches 64 pending messages.
- 14:25 UTC: the coordinator pauses the reminder job.
- 14:41 UTC: the confirmation queue drains.

## Findings

The reminder job used the same worker pool as reservation confirmations. It consumed all four workers while waiting for an external email service. Reservation records remained intact; no double reservations were observed.

## Follow-up

Assign a separate worker pool to reminders. Alert if confirmation queue age exceeds two minutes. Owner: Theo Martin. Due date: 2026-10-09.

The proposed reservation-desk pilot should include a worker-saturation check before expansion.
