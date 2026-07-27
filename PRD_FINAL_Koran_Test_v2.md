# PRD FINAL — Koran Test v2.0
## Cloud Platform, Realtime Leaderboard, User Profile & Admin System

Version: 2.0 MVP Production Ready

## Product Overview
Koran Test adalah platform latihan Tes Pauli dan Kraepelin berbasis web yang dapat digunakan secara gratis oleh seluruh pengguna untuk mempersiapkan diri menghadapi psikotes kerja.

Platform berjalan pada mobile, tablet, dan desktop. Sistem saat ini menggunakan localStorage dan akan dimigrasikan menjadi platform cloud berbasis database dengan leaderboard realtime dan panel admin lengkap.

## Product Goals
- Menyediakan simulasi Kraepelin/Pauli gratis
- Menyimpan progres pengguna di cloud
- Menampilkan leaderboard nasional realtime
- Membangun komunitas latihan psikotes
- Menyediakan statistik perkembangan pengguna
- Menyediakan dashboard admin lengkap

## Technology Stack

### Frontend
- HTML
- Tailwind CSS
- Vanilla JavaScript

### Backend
Gunakan Supabase:
- PostgreSQL Database
- Authentication
- Realtime
- Storage
- Row Level Security (RLS)

## Authentication System

### Email & Password
- Register
- Login
- Email Verification
- Forgot Password
- Change Password

### Google Authentication
Menggunakan Supabase Google OAuth:
- Login dengan Google
- Register dengan Google
- Auto Create Account
- Auto Login
- Mengambil Email, Full Name, dan Avatar

### Account Linking
Jika email Google sama dengan email akun yang sudah ada:
- Jangan membuat akun baru
- Hubungkan ke akun yang sudah ada

## User Profile System

URL:
`/user/:username`

Field:
- id
- username
- display_name
- email
- avatar_url
- bio
- best_score
- best_accuracy
- total_tests
- total_play_time
- created_at
- updated_at

### Username Rules
- Username wajib unik
- Digunakan pada leaderboard
- Dapat diubah maksimal 1x setiap 7 hari
- Simpan timestamp perubahan terakhir
- Tampilkan countdown perubahan berikutnya

### Editable Fields
- Username
- Display Name
- Avatar
- Bio
- Email

## Test System

### Standard Test (5 Menit)
Leaderboard hanya mengambil hasil Standard Test.
Mode lain tetap tersedia untuk latihan.

## Score System

Formula:

`Score = Total Correct × (Accuracy / 100)`

Gunakan integer.

## Ranked Eligibility
- User login
- Email terverifikasi
- Standard Test
- Hasil valid
- Tidak terindikasi curang

## Best Score System

Jika score baru lebih tinggi dari best_score maka update.
Jika tidak, abaikan.

## Leaderboard System

### Global Leaderboard
Top 100 All Time

Urutan:
1. Score DESC
2. Accuracy DESC
3. Created At ASC

### Weekly Leaderboard
Top 100 Mingguan

Filter:
`created_at >= start_of_week`

### Leaderboard Display
- Rank
- Avatar
- Username
- Score
- Accuracy
- Total Test

## Public Profile
Menampilkan:
- Avatar
- Username
- Display Name
- Join Date
- Global Rank
- Best Score
- Average Accuracy
- Average Consistency
- Total Tests
- Latest Results

## History System
Semua hasil tes tersimpan di cloud.

## Achievement System

Badge:
- Bronze
- Silver
- Gold
- Diamond

Achievement:
- First Test
- 10 Tests Completed
- 50 Tests Completed
- Top 100
- Top 10
- Weekly Champion

## Announcement System
Admin dapat membuat pengumuman yang tampil di homepage.

## Article System
Untuk SEO dan edukasi.

Field:
- title
- slug
- thumbnail
- content
- published
- created_at

## Anti Cheat System

### Client Side
- Auto Click Detection
- Script Injection Detection
- Input Speed Validation
- Focus Lost Detection

### Server Side
- Duration Validation
- Total Input Validation
- Accuracy Validation
- Score Recalculation

Server wajib menghitung ulang score.

## Admin System

Roles:
- admin
- super_admin

### Dashboard
- Total Users
- Total Tests
- Total Ranked Results
- Total Articles
- Total Announcements
- Active Users
- New Users This Week
- Flagged Users

### User Management
- Search User
- View Profile
- Edit User
- Suspend User
- Delete User
- Reset User Score

### Result Management
- View Results
- Filter Results
- Delete Result
- Flag Cheat
- Remove Cheat Flag

### Leaderboard Management
- Remove Score
- Recalculate Ranking
- Reset Weekly Ranking

### Article Management
CRUD Article

### Announcement Management
CRUD Announcement

### Badge Management
- Create Badge
- Update Badge
- Delete Badge
- Assign Badge

## Database Schema

### profiles
- id
- username
- display_name
- email
- avatar_url
- bio
- best_score
- best_accuracy
- total_tests
- total_play_time
- username_changed_at
- created_at
- updated_at

### test_results
- id
- user_id
- mode
- total_answered
- correct_answers
- accuracy
- consistency
- duration
- score
- is_valid
- is_flagged
- created_at

### announcements
- id
- title
- content
- created_at

### articles
- id
- title
- slug
- thumbnail
- content
- published
- created_at

### badges
- id
- name
- description
- icon

### user_badges
- id
- user_id
- badge_id
- created_at

## Migration Plan

1. Setup Supabase
2. Setup Auth
3. Setup Database
4. Migrate Login
5. Migrate History
6. Migrate Profile
7. Build Leaderboard
8. Build Public Profile
9. Build Admin Dashboard
10. Build Realtime System
11. Build Anti Cheat

## UI Requirements

Pertahankan UI yang sudah ada.

Jangan merombak:
- Test Engine
- Test Screen
- Numpad Layout
- Landing Page Layout

Tambahkan:
- Leaderboard
- Public Profile
- Articles
- Announcements
- Admin Dashboard

Fokus implementasi pada backend, database, leaderboard realtime, profil pengguna, dan sistem admin.
