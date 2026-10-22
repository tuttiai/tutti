from .invoice_ledger import InvoiceLedger, open_ledger


def billing_report():
    ledger = open_ledger()
    return ledger.record_payment(10)
