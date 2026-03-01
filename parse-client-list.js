// Script to parse the client list markdown file and generate CSV for bulk update
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../Downloads/Client list Jan 2026.md');

try {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  const clients = [];
  let currentClient = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === 'Client list Jan 2026') continue;
    
    // Check if this is a new client entry (starts with a number)
    const clientMatch = line.match(/^(\d+)\.\s+(\w+)\s*\(/);
    if (clientMatch) {
      // Save previous client if exists
      if (currentClient) {
        clients.push(currentClient);
      }
      
      const nickname = clientMatch[2];
      
      // Extract diagnoses (F codes)
      const diagnosisMatches = line.match(/\bF\d+\.\d+\b/g);
      const diagnoses = diagnosisMatches ? diagnosisMatches.join(', ') : '';
      
      // Extract email from markdown link or plain text
      let email = '';
      const emailLinkMatch = line.match(/\[([^\]]+@[^\]]+)\]\(mailto:[^\)]+\)/);
      if (emailLinkMatch) {
        email = emailLinkMatch[1];
      } else {
        const emailPlainMatch = line.match(/\b([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})\b/);
        if (emailPlainMatch) {
          email = emailPlainMatch[1];
        }
      }
      
      // Check next line for email if not found
      if (!email && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        const emailLinkMatch2 = nextLine.match(/\[([^\]]+@[^\]]+)\]\(mailto:[^\)]+\)/);
        if (emailLinkMatch2) {
          email = emailLinkMatch2[1];
        } else {
          const emailPlainMatch2 = nextLine.match(/\b([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})\b/);
          if (emailPlainMatch2) {
            email = emailPlainMatch2[1];
          }
        }
      }
      
      // Handle multiple emails (take first one)
      if (email.includes(',')) {
        email = email.split(',')[0].trim();
      }
      
      currentClient = {
        name: nickname,
        email: email,
        diagnosis: diagnoses
      };
    } else if (currentClient && line.toLowerCase().includes('email')) {
      // Additional email line
      const emailLinkMatch = line.match(/\[([^\]]+@[^\]]+)\]\(mailto:[^\)]+\)/);
      if (emailLinkMatch && !currentClient.email) {
        currentClient.email = emailLinkMatch[1];
      } else {
        const emailPlainMatch = line.match(/\b([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})\b/);
        if (emailPlainMatch && !currentClient.email) {
          currentClient.email = emailPlainMatch[1];
        }
      }
    }
  }
  
  // Add last client
  if (currentClient) {
    clients.push(currentClient);
  }
  
  // Generate CSV
  let csv = 'Name,Email,Diagnosis\n';
  clients.forEach(client => {
    const name = client.name.replace(/,/g, ';');
    const email = (client.email || '').replace(/,/g, '');
    const diagnosis = (client.diagnosis || '').replace(/,/g, ';');
    csv += `${name},${email},${diagnosis}\n`;
  });
  
  // Write to file
  const outputPath = path.join(__dirname, 'client-updates.csv');
  fs.writeFileSync(outputPath, csv, 'utf8');
  
  console.log(`Parsed ${clients.length} clients`);
  console.log(`CSV written to: ${outputPath}`);
  console.log('\nFirst few entries:');
  clients.slice(0, 5).forEach(c => {
    console.log(`  ${c.name}: ${c.email || 'no email'} - ${c.diagnosis || 'no diagnosis'}`);
  });
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
