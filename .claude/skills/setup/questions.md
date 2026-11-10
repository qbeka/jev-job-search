# The setup questions

Every question the tool needs answered once, and where the answer goes in
`data/profile.json`. Ask them in this order. Skip a question only when the
resume or the user has already answered it. "Decline" is always allowed in
part F.

## A. Who you are

| Ask | Goes in |
|---|---|
| Your legal first and last name, as on your documents | `name.first`, `name.last` |
| A name you prefer to be called, if different | `name.preferred` |
| Your pronouns (optional) | `pronouns` |
| The email address employers should write to | `email` |
| Your phone number and its country code | `phone.national` (digits only), `phone.countryCode` |
| Your full mailing address: street, city, province or state, postal code, country | `address` |
| Your date of birth (optional; a few forms ask) | `dateOfBirth` |
| Your LinkedIn, GitHub, and personal site or portfolio | `links` |

## B. Your education

| Ask | Goes in |
|---|---|
| School, degree, field of study, minor | `education[0]` |
| The month and year you started, and the month and year you graduate | `startMonth`, `startYear`, `gradMonth`, `gradYear` |
| Whether the degree is in progress or finished | `status` |
| Your GPA and its scale (optional) | `gpa.cumulative`, `gpa.scale` |
| Should the tool give your GPA whenever a form has a box for it, or only when the form cannot be sent without it? | `gpa.volunteer` (true or false) |

## C. Where you may work

| Ask | Goes in |
|---|---|
| Your citizenships | `workAuthorization.citizenships` |
| The countries where you can work today with no visa sponsorship | `workAuthorization.authorizedCountries` |
| Any country where you may work now or by your start date but will need sponsorship later, such as the United States on F-1 OPT or STEM OPT (often none) | `workAuthorization.authorizedWithSponsorshipLater` |
| Would you need sponsorship to work anywhere else? | `workAuthorization.requiresSponsorshipElsewhere` |
| One sentence that states your status, for forms that ask you to explain | `workAuthorization.statement` |

These answers are never changed to suit a job. If the user is unsure of
their status, they should check before applying.

## D. What you are looking for

| Ask | Goes in |
|---|---|
| Internships, new-grad roles, or both, and for which terms | `summary`, and a standing answer |
| The earliest date you can start | `preferences.earliestStart` |
| How long you can work: term lengths, or "permanent" | `preferences.availability` |
| The places you want to work, best first | `preferences.preferredLocations` |
| Will you relocate? | `preferences.willingToRelocate` |
| Remote work: preferred, open to it, or no | `preferences.remote` |
| Can you work in an office or hybrid if the job needs it? | a standing answer |

## E. What you have done

| Ask | Goes in |
|---|---|
| Is every job and project on the resume right, with exact numbers? | `experience`, `projects` |
| Anything not on the resume that you would mention: awards, hackathons, coursework, open source | `facts` |
| Languages you speak, and how well | `spokenLanguages` |
| Programming languages, frameworks and tools, as you would list them | `skills` |

## F. Voluntary self-identification

Many forms ask these. Each one is optional. Record "Prefer not to say" (or
`decline` for the yes/no ones) if the user does not want to answer.

| Ask | Goes in |
|---|---|
| Gender | `demographics.gender` |
| Race or ethnicity | `demographics.ethnicity` |
| Hispanic or Latino: yes, no, decline | `demographics.hispanicOrLatino` |
| Veteran: yes, no, decline | `demographics.veteran` |
| Disability: yes, no, decline | `demographics.disability` |
| Sexual orientation | `demographics.sexualOrientation` |
| Transgender: yes, no, decline | `demographics.transgender` |

## G. Standing answers

Questions that come back on form after form. Each becomes one entry in
`answers`: the question as you would recognise it, and how the user wants
it answered. Write the answer in the user's words.

1. Pay. Is there a number or a range you want to give? If not, the tool
   leaves pay boxes empty, and writes `preferences.salaryIfRequired`
   ("Negotiable" unless you choose other words) when a box is required.
   Also ask: when a form asks whether a stated rate or range is acceptable,
   is the answer yes?
2. How did you hear about the job? (`preferences.howDidYouHear`, and a
   standing answer that says which option to pick from a list.)
3. Text messages, marketing email and job alerts: agree or decline?
4. May the company keep your details for future roles, or add you to its
   talent community?
5. Are you employed now, and what is your notice period?
6. History questions the resume does not cover: a criminal conviction, a
   non-compete agreement, having worked at or applied to the company
   before, relatives who work there, a security clearance. Ask for each one
   plainly. Do not assume "no".
7. If a posting asks for a graduation date or year of study that is not
   yours, should the tool still apply? Every date is still answered
   truthfully.
8. Which area of engineering do you prefer, in order? Forms often ask you
   to rank front end, back end, full stack, mobile, data, infrastructure.
9. Which AI tools do you use, and how?
10. How many internships or jobs have you held? (Count them with the user.)
11. Are you free to travel for an interview or a test in person? The tool
    never picks a date or a time for you.
12. Are you 18 or older? Some forms ask.
13. Would you take a pre-employment drug test and a background check?
14. Do you have a transcript to attach when a form requires one? If so,
    its path goes in `transcript.path`. If not, such forms are left for you.
15. Anything you never want the tool to say or to answer for you.

Two choices are fixed in this version, so tell the user and do not ask:
the tool never writes a cover letter and never gives references. It skips
jobs that require either.
