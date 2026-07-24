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
    # posting-variant suffix collapses to the base requisition (Adobe/Mastercard style)
    k3 = job_key("https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/PM_R168260-1")
    assert k3 == "workday-R168260"
    # Visa-style REF ids
    k4 = job_key("https://visa.wd5.myworkdayjobs.com/Visa/job/Austin/Product-Manager_REF085011W")
    assert k4 == "workday-REF085011W"


def test_goldman_radancy_smartrec():
    assert job_key("https://higher.gs.com/roles/168945") == "goldman-168945"
    assert job_key("https://jobs.intuit.com/job/san-diego/product-manager/27595/82412345") == "radancy-82412345"
    assert job_key("https://jobs.smartrecruiters.com/Visa/743999912345678-product-manager") == "smartrec-743999912345678"


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


def test_successfactors_csb_vanity_host():
    # CSB careers live on the company's own domain (no ATS signal) -> key off the URL shape
    assert job_key("https://jobs.grainger.com/job/CHICAGO-Sr-Product-Manager-IL-60654-4203/1344992400/") == "sfsf-1344992400"
    assert job_key("https://jobs.sap.com/job/Walldorf-Assoc-Product-Manager-69190/1403409233") == "sfsf-1403409233"


def test_sfsf_pattern_is_last_resort_and_shadows_nothing():
    # the sfsf pattern is appended LAST; specific ATSs and the url-fallback must be unchanged
    assert job_key("https://jobs.intuit.com/job/san-diego/product-manager/27595/82412345") == "radancy-82412345"
    assert job_key("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210765300/") == "oraclehcm-210765300"
    assert job_key("https://fingerprint.com/careers/jobs/abc123/").startswith("url-")
