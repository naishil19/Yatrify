CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT,
  image_url TEXT,
  first_name TEXT,
  last_name TEXT,
  credits NUMERIC(6,2) DEFAULT 2.00,
  plan_tier TEXT DEFAULT 'free',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE plans (
  id UUID PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  start_city TEXT,
  destination TEXT,
  start_date DATE,
  end_date DATE,
  themes JSONB DEFAULT '[]',
  pace TEXT,
  weather TEXT,
  accommodation JSONB DEFAULT '[]',
  food JSONB DEFAULT '[]',
  transport JSONB DEFAULT '[]',
  currency TEXT DEFAULT 'INR',
  budget TEXT,
  passengers TEXT,
  preferences TEXT,
  sections JSONB DEFAULT '{}'::jsonb,
  hero_image_url TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMP,
  visit_start_date DATE,
  visit_end_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE plan_collaborators (
  id UUID PRIMARY KEY,
  plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
  invited_email TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role TEXT DEFAULT 'collaborator',
  status TEXT DEFAULT 'invited',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(plan_id, invited_email)
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY,
  plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  description TEXT,
  who TEXT,
  category TEXT,
  amount NUMERIC,
  date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
  delta NUMERIC(6,2) NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE plan_catalog (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  credits_included NUMERIC(6,2),
  price_amount NUMERIC,
  currency TEXT DEFAULT 'INR',
  trip_days_limit INTEGER,
  cta_label TEXT,
  cta_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE plan_catalog_features (
  id UUID PRIMARY KEY,
  plan_catalog_id UUID REFERENCES plan_catalog(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE community_plans (
  id UUID PRIMARY KEY,
  plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
  source TEXT DEFAULT 'user',
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP,
  UNIQUE(plan_id)
);
