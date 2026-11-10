/**
 * The canonical list of things a form field can be filled with. JEV picks
 * one key per field; `valueFor` turns the key into the string that goes in
 * the box. Keys are the choice criteria, so each description must be a clear
 * definition the model can match a label against.
 */
import { monthName, sponsorshipLater, type Profile } from "./schema.js";

export const SPECIAL_KEYS = {
  resume_upload: "A file input for the resume or CV",
  free_text: "An open question that needs a written answer in the candidate's words (why this company, describe a project, anything a bank answer does not cover)",
  leave_blank: "Optional and not applicable: cover letter, salary expectation, references, middle name, second phone, address line 2, anything about a current employer the candidate does not have",
  unknown: "The label does not match any key and it is not clearly optional",
} as const;

export const PROFILE_KEYS = {
  first_name: "First or given name",
  last_name: "Last name, surname or family name",
  full_name: "Full name in one field",
  preferred_name: "Preferred name or nickname",
  email: "Email address",
  phone: "Phone number without country code",
  phone_with_country_code: "Phone number in international format with country code",
  phone_country_code: "Phone country code or country selector",
  phone_and_email: "One box that asks for both a phone number and an email address",
  address_line1: "Street address, first line",
  city: "City",
  state_province: "State, province or region",
  postal_code: "Postal or ZIP code",
  country: "Country of residence",
  full_address: "Whole mailing address in one field",
  current_location: "Location, current location, or where the candidate is based (a plain Location field on an application means where the candidate lives now)",
  linkedin_url: "LinkedIn profile URL",
  github_url: "GitHub profile URL",
  website_url: "Personal website, portfolio or blog URL",
  school: "University, college or school name",
  degree: "Degree type or level, such as Bachelor's",
  major: "Field of study or major",
  minor: "Minor",
  education_start_date: "Start date or start month and year of the degree, under an Education or School section",
  education_start_month: "Start month only of the degree, under an Education section",
  education_start_year: "Start year only of the degree, under an Education section",
  graduation_date: "Expected graduation date, end date of the degree, month and year",
  graduation_month: "Graduation month only",
  graduation_year: "Graduation or class year only",
  gpa: "GPA or grade point average",
  education_level: "Highest level of education completed or in progress",
  currently_enrolled: "Whether the candidate is currently a student",
  citizenship: "Country of citizenship or nationality",
  work_authorization_country: "Country the candidate is authorized to work in",
  authorized_to_work: "Yes or no: legally authorized to work in the posting's country",
  requires_sponsorship: "Yes or no: will require visa sponsorship now or in the future",
  work_authorization_statement: "Open explanation of work authorization or visa status",
  pronouns: "Pronouns",
  date_of_birth: "Date of birth",
  gender: "Gender",
  ethnicity: "Ethnicity or race",
  hispanic_or_latino: "Hispanic or Latino yes or no",
  veteran_status: "Veteran or military status",
  disability_status: "Disability status",
  sexual_orientation: "Sexual orientation",
  transgender: "Transgender identity question",
  current_company: "Current or most recent employer",
  current_title: "Current or most recent job title",
  years_of_experience: "Total years of professional experience",
  skills: "Technical skills or technologies, comma separated",
  spoken_languages: "Languages spoken",
  earliest_start_date: "Earliest or preferred date the candidate can start the job (not an education date)",
  availability: "Availability, work term length or duration",
  salary_expectation: "Expected salary or compensation",
  willing_to_relocate: "Willing to relocate yes or no",
  remote_preference: "Remote, hybrid or onsite preference",
  preferred_location: "Preferred office or desired work location, only when the form explicitly asks for a preference or a choice of office",
  how_did_you_hear: "How did you hear about this job or source",
  answer_yes: "A yes or no question about the candidate whose truthful answer, from the facts, is Yes (able to start in the stated window, will hold a Bachelor's by graduation, enrolled now, can work hybrid or on site, over 18)",
  answer_no: "A yes or no question about the candidate whose truthful answer, from the facts, is No (previously employed here, has a non-compete, needs an accommodation, is a former intern, related to an employee)",
  consent_yes: "Consent, acknowledgement, privacy notice or terms checkbox that must be accepted to apply",
  notifications_opt_in: "Marketing or job alert opt in that is optional",
  previously_applied: "Whether the candidate has applied or worked at this company before",
  referral_name: "Name of a referring employee",
  hackathons: "Hackathon or competition record",
} as const;

export type ProfileKey = keyof typeof PROFILE_KEYS;
export type SpecialKey = keyof typeof SPECIAL_KEYS;
export type FieldKey = ProfileKey | SpecialKey;

export const ALL_KEYS: Record<FieldKey, string> = { ...PROFILE_KEYS, ...SPECIAL_KEYS };

export function isProfileKey(key: string): key is ProfileKey {
  return key in PROFILE_KEYS;
}

export function isSpecialKey(key: string): key is SpecialKey {
  return key in SPECIAL_KEYS;
}

/** The value for a profile key, or null when the profile deliberately leaves it empty. */
export function valueFor(profile: Profile, key: ProfileKey): string | null {
  const edu = profile.education[0];
  if (!edu) throw new Error("profile.education must have at least one entry");
  const job = profile.experience[0];
  const yes = (v: "yes" | "no" | "decline") => (v === "yes" ? "Yes" : v === "no" ? "No" : "I do not wish to answer");
  switch (key) {
    case "first_name": return profile.name.first;
    case "last_name": return profile.name.last;
    case "full_name": return `${profile.name.first} ${profile.name.last}`;
    case "preferred_name": return profile.name.preferred ?? profile.name.first;
    case "email": return profile.email;
    case "phone": return profile.phone.national;
    case "phone_with_country_code": return `${profile.phone.countryCode}${profile.phone.national}`;
    case "phone_country_code": return profile.phone.countryCode;
    case "phone_and_email": return `${profile.phone.countryCode} ${profile.phone.national}, ${profile.email}`;
    case "address_line1": return profile.address.line1;
    case "city": return profile.address.city;
    case "state_province": return profile.address.region;
    case "postal_code": return profile.address.postalCode;
    case "country": return profile.address.country;
    case "full_address":
      return `${profile.address.line1}, ${profile.address.city}, ${profile.address.regionCode} ${profile.address.postalCode}, ${profile.address.country}`;
    case "current_location": return `${profile.address.city}, ${profile.address.region}, ${profile.address.country}`;
    case "linkedin_url": return profile.links.linkedin;
    case "github_url": return profile.links.github;
    case "website_url": return profile.links.website ?? profile.links.portfolio ?? profile.links.github;
    case "school": return edu.school;
    case "degree": return edu.degree;
    case "major": return edu.field;
    case "minor": return edu.minor ?? null;
    case "education_start_date": return `${monthName(edu.startMonth)} ${edu.startYear}`;
    case "education_start_month": return monthName(edu.startMonth);
    case "education_start_year": return String(edu.startYear);
    case "graduation_date": return `${monthName(edu.gradMonth)} ${edu.gradYear}`;
    case "graduation_month": return monthName(edu.gradMonth);
    case "graduation_year": return String(edu.gradYear);
    case "gpa": {
      const g = edu.gpa;
      if (!g || g.cumulative === undefined) return null;
      return g.volunteer ? g.cumulative.toFixed(2) : null;
    }
    case "education_level": return edu.degree;
    case "currently_enrolled": return edu.status === "in_progress" ? "Yes" : "No";
    case "citizenship": return profile.workAuthorization.citizenships.join(", ");
    case "work_authorization_country": return [...new Set([...profile.workAuthorization.authorizedCountries, ...sponsorshipLater(profile)])].join(", ");
    case "authorized_to_work": return null; // decided per posting country by the select mapper
    case "requires_sponsorship": return null; // decided per posting country by the select mapper
    case "work_authorization_statement": return profile.workAuthorization.statement;
    case "pronouns": return profile.pronouns ?? null;
    case "date_of_birth": return profile.dateOfBirth ?? null;
    case "gender": return profile.demographics.gender;
    case "ethnicity": return profile.demographics.ethnicity;
    case "hispanic_or_latino": return yes(profile.demographics.hispanicOrLatino);
    case "veteran_status": return yes(profile.demographics.veteran);
    case "disability_status": return yes(profile.demographics.disability);
    case "sexual_orientation": return profile.demographics.sexualOrientation;
    case "transgender": return yes(profile.demographics.transgender);
    case "current_company": return job?.company ?? null;
    case "current_title": return job?.title ?? null;
    case "years_of_experience": return String(yearsOfExperience(profile));
    case "skills": return [...profile.skills.languages, ...profile.skills.frameworks, ...profile.skills.tools].join(", ");
    case "spoken_languages": return profile.spokenLanguages.map((l) => `${l.name} (${l.level})`).join(", ");
    case "earliest_start_date": return profile.preferences.earliestStart;
    case "availability": return profile.preferences.availability;
    case "salary_expectation": return profile.preferences.salaryExpectation || null;
    case "willing_to_relocate": return yes(profile.preferences.willingToRelocate);
    case "remote_preference": return profile.preferences.remote === "preferred" ? "Remote preferred, open to hybrid or onsite" : "Open to remote, hybrid or onsite";
    case "preferred_location": return profile.preferences.preferredLocations[0] ?? null;
    case "how_did_you_hear": return profile.preferences.howDidYouHear;
    case "answer_yes": return "Yes";
    case "answer_no": return "No";
    case "consent_yes": return "Yes";
    case "notifications_opt_in": return null;
    case "previously_applied": return "No";
    case "referral_name": return null;
    case "hackathons": return profile.facts.find((f) => /hackathon/i.test(f)) ?? null;
  }
}

/** Whole years of experience across internships and founder roles, rounded down, minimum 0. */
export function yearsOfExperience(profile: Profile): number {
  let months = 0;
  for (const e of profile.experience) {
    const start = parseMonth(e.start);
    const end = e.current ? new Date() : parseMonth(e.end);
    if (start && end) months += Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth());
  }
  return Math.floor(months / 12);
}

function parseMonth(s: string): Date | null {
  const d = new Date(s.length === 7 ? `${s}-01` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Flat facts for a JEV state: everything the model may need to pick a select option. */
export function profileFacts(profile: Profile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(PROFILE_KEYS) as ProfileKey[]) {
    const v = valueFor(profile, key);
    if (v !== null && v !== "") out[key] = v;
  }
  out.citizenships = profile.workAuthorization.citizenships.join(", ");
  out.authorized_countries = profile.workAuthorization.authorizedCountries.join(", ");
  const later = sponsorshipLater(profile);
  if (later.length) out.authorized_now_but_needs_sponsorship_later_in = later.join(", ");
  out.requires_sponsorship_outside_authorized_countries = profile.workAuthorization.requiresSponsorshipElsewhere ? "Yes" : "No";
  return out;
}
