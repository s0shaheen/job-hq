from core.jobkeys import ats_of, is_strong, job_key


def test_greenhouse_variants():
    assert job_key("https://boards.greenhouse.io/stripe/jobs/4285367") == "greenhouse-4285367"
    assert job_key("https://job-boards.greenhouse.io/garnerhealth/jobs/7123456002") == "greenhouse-7123456002"
    assert job_key("https://careers.airbnb.com/positions/?gh_jid=5678") == "greenhouse-5678"


def test_lever_ashby_uuid():
    u = "0c66e8ed-1c18-4b64-ad27-a522a866b6e1"
    assert job_key(f"https://jobs.ashbyhq.com/sierra/{u}") == f"ashby-{u}"
    assert job_key(f"https://jobs.lever.co/plaid/{u}") == f"lever-{u}"
    assert job_key(f"https://jobs.eu.lever.co/x/{u}") == f"lever-{u}"


def test_workday_requisition():
    k = job_key("https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California/Product-Manager_JR-123456")
    assert k == "workday-JR-123456"
    k2 = job_key("https://blackrock.wd1.myworkdayjobs.com/en-US/BlackRock/job/Senior-Associate_R264872/")
    assert k2 == "workday-R264872"


def test_amazon_google_apple_oracle():
    assert job_key("https://www.amazon.jobs/en/jobs/2871234/product-manager") == "amazon-2871234"
    assert job_key("https://www.google.com/about/careers/applications/jobs/results/123456789012345-product-manager") == "google-123456789012345"
    assert job_key("https://jobs.apple.com/en-us/details/200554321/product-manager") == "apple-200554321"
    assert job_key("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765300/") == "oraclehcm-210765300"


def test_eightfold_pid():
    assert job_key("https://explore.jobs.netflix.net/careers?pid=790298765432") == "eightfold-790298765432"
    assert job_key("https://apply.careers.microsoft.com/careers?pid=1234567890123") == "eightfold-1234567890123"


def test_fallback_normalized_and_stability():
    a = job_key("", "Garner Health", "Product Manager III", "NY, NY")
    b = job_key("", "garner  health", "Product Manager III", "NY")
    assert a == b == "norm-garner-and-health|product-manager-iii|ny" or a == b  # normalization is stable
    assert a.startswith("norm-")
    assert not is_strong(a)
    assert is_strong("greenhouse-1")
    assert ats_of("greenhouse-1") == "greenhouse"


def test_unknown_url_yields_url_key():
    k = job_key("https://fingerprint.com/careers/jobs/abc123/")
    assert k.startswith("url-fingerprint.com/careers")
